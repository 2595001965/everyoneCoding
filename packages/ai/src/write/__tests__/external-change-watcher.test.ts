import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch as fsWatch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createExternalChangeWatcher,
  DEFAULT_IGNORE_PATTERNS,
  ExternalChangeWatcher,
  shouldIgnorePath,
} from '../external-change-watcher';
import { createReadOnlyGuard, isAllowedKey, scanReadOnlyCompliance } from '../read-only-guard';

/**
 * 外部改动检测（T4-05 要点 3 / 验收：用脚本改文件验证）。
 *
 * 这里**故意用真实文件系统 + 真实 child process 改文件**：
 * "外部编辑器改了文件能不能被发现"是 OS 层面的事件语义，
 * 用假监听器测只能证明"回调会被调用"，证明不了"真有人改文件时会被发现"。
 */

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ec-watch-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** 真实 child process 写文件（模拟"外部编辑器/脚本改了代码"） */
function writeFileByScript(path: string, content: string): void {
  const script = `require('node:fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});`;
  // 用真实的独立进程写文件，而不是测试进程自己的 fs 句柄
  execFileSync(process.execPath, ['-e', script]);
}

/**
 * 真实 fs.watch 适配器。
 *
 * 注意 `close()` 的实现：Windows 上 `FSWatcher.close(cb)` 的回调在本环境并不触发，
 * 因此这里只调用 close 并立刻 resolve —— 这正是 `WatchHandleLike` 的契约
 * （调用方不应依赖"关闭回调必达"）。
 */
function realWatch(path: string, listener: (event: { type: 'create' | 'modify' | 'remove'; path: string }) => void) {
  const handle = fsWatch(path, { recursive: true }, (eventType, filename) => {
    const name = typeof filename === 'string' ? filename : String(filename ?? '');
    const type: 'create' | 'modify' | 'remove' =
      eventType === 'rename' ? (name.includes('.') ? 'modify' : 'remove') : 'modify';
    listener({ type, path: join(path, name) });
  });
  return Promise.resolve({
    close: async () => {
      handle.close();
    },
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe('外部改动检测（T4-05 要点 3）', () => {
  it('脚本修改工作区文件后 100% 被检测到并给出提示', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'auth.controller.ts');
    writeFileByScript(target, 'export const v1 = 1;\n');

    const watcher = createExternalChangeWatcher({ watch: realWatch });
    const detected: string[] = [];
    watcher.onDetected((change) => detected.push(change.path));
    await watcher.start(dir);

    writeFileByScript(target, 'export const v2 = 2;\n');
    const found = await waitUntil(() => watcher.changes().length > 0);
    await watcher.stop();

    expect(found).toBe(true);
    const change = watcher.changes()[0];
    expect(change?.path.replace(/\\/g, '/')).toContain('auth.controller.ts');
    expect(detected.length).toBeGreaterThan(0);
    expect(ExternalChangeWatcher.describe(change ?? null)).toContain('代码已被外部修改');
    expect(ExternalChangeWatcher.actions().map((action) => action.label)).toEqual(['回滚到最近提交', '让 AI 重新生成']);
    // 文件确实变了（证明检测的是真实变更而不是误报）
    expect(readFileSync(target, 'utf8')).toBe('export const v2 = 2;\n');
  });

  it('AI 自身写入被抑制，不会把自己的写入报成外部改动', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'b.ts');
    writeFileByScript(target, 'v1\n');

    const watcher = createExternalChangeWatcher({ watch: realWatch, suppressWindowMs: 5_000 });
    await watcher.start(dir);
    watcher.suppress(target);

    writeFileByScript(target, 'v2（AI 写入）\n');
    const detected = await waitUntil(() => watcher.changes().length > 0, 1_500);
    await watcher.stop();

    expect(detected).toBe(false);
    expect(watcher.isSuppressed(target)).toBe(true);
  });

  it('排除 .git / node_modules / dist 等噪声目录', async () => {
    expect(shouldIgnorePath('D:/p/node_modules/react/index.js')).toBe(true);
    expect(shouldIgnorePath('D:/p/.git/index')).toBe(true);
    expect(shouldIgnorePath('D:/p/dist/main.js')).toBe(true);
    expect(shouldIgnorePath('D:/p/apps/renderer/target/debug/x')).toBe(true);
    expect(shouldIgnorePath('D:/p/src/a.ts')).toBe(false);
    expect(DEFAULT_IGNORE_PATTERNS).toContain('node_modules');

    const dir = makeTempDir();
    const noise = join(dir, 'node_modules');
    writeFileByScript(join(dir, 'placeholder.ts'), 'x\n');
    const watcher = createExternalChangeWatcher({ watch: realWatch });
    await watcher.start(dir);
    mkdirSync(noise, { recursive: true });
    writeFileByScript(join(noise, 'noisy.js'), 'noise\n');
    const detected = await waitUntil(() => watcher.changes().length > 0, 1_500);
    await watcher.stop();
    expect(detected).toBe(false);
  });

  it('同路径的连续事件在合并窗口内只记一条，drain 后清空', async () => {
    let now = 1_000;
    // 用对象持有回调：直接 `let emit` 会被 TS 的控制流分析永久窄化成 null
    const captured: { emit: ((event: { type: 'modify'; path: string }) => void) | null } = { emit: null };
    const watcher = createExternalChangeWatcher({
      watch: (_path, listener) => {
        captured.emit = listener;
        return Promise.resolve({ close: () => Promise.resolve() });
      },
      clock: () => now,
      coalesceWindowMs: 300,
    });
    await watcher.start('/ws');

    captured.emit?.({ type: 'modify', path: '/ws/a.ts' });
    now += 100;
    captured.emit?.({ type: 'modify', path: '/ws/a.ts' });
    now += 1_000;
    captured.emit?.({ type: 'modify', path: '/ws/a.ts' });
    now += 10;
    captured.emit?.({ type: 'modify', path: '/ws/b.ts' });

    const changes = watcher.changes();
    expect(changes).toHaveLength(3);
    expect(changes[0]?.count).toBe(2);
    expect(watcher.drain()).toHaveLength(3);
    expect(watcher.changes()).toHaveLength(0);
  });
});

/* ------------------------------ 只读约束 ------------------------------ */

describe('只读守卫（T4-05 要点 2 / E2E-18）', () => {
  it('键拦截：普通字符与退格被拦，复制与方向键放行', () => {
    const blocked: string[] = [];
    const guard = createReadOnlyGuard({ onBlockedEdit: (event) => blocked.push(event.reason) });

    const makeEvent = (key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
      const event = {
        key,
        ...modifiers,
        prevented: false,
        stopped: false,
        preventDefault() {
          this.prevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
      };
      return event;
    };

    const typed = makeEvent('a');
    guard.props.onKeyDown(typed);
    expect(typed.prevented).toBe(true);
    expect(blocked).toEqual(['keydown']);

    const backspace = makeEvent('Backspace');
    guard.props.onKeyDown(backspace);
    expect(backspace.prevented).toBe(true);

    const copy = makeEvent('c', { ctrlKey: true });
    guard.props.onKeyDown(copy);
    expect(copy.prevented).toBe(false);

    const arrow = makeEvent('ArrowDown');
    guard.props.onKeyDown(arrow);
    expect(arrow.prevented).toBe(false);

    expect(isAllowedKey({ key: 'v', ctrlKey: true })).toBe(false);
    expect(guard.blockedCount()).toBe(2);
    expect(guard.lastBlock()?.reason).toBe('keydown');
  });

  it('粘贴 / 拖拽 / 剪切 / beforeinput 全部被拦截并带上原因', () => {
    const reasons: string[] = [];
    const guard = createReadOnlyGuard({ onBlockedEdit: (event) => reasons.push(event.reason) });
    const event = {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      clipboardData: { getData: () => 'pasted code' },
      dataTransfer: { types: ['text/plain'] },
      data: 'x',
    };

    guard.props.onPaste(event);
    guard.props.onDrop(event);
    guard.props.onCut(event);
    guard.props.onBeforeInput(event);

    expect(reasons).toEqual(['paste', 'drop', 'cut', 'beforeinput']);
    expect(guard.blockedCount()).toBe(4);
  });

  it('静态扫描：代码视图本体必须声明只读且不含任何可编辑标记', () => {
    const codeViewPath = 'apps/renderer/src/features/code/CodeView.tsx';
    const result = scanReadOnlyCompliance([
      { path: codeViewPath, content: readFileSync(join(process.cwd(), codeViewPath), 'utf8') },
    ]);

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.marked).toContain(codeViewPath);
    expect(result.checked).toEqual([codeViewPath]);
  });

  it('扫描会剥掉注释：说明性文字里出现 contentEditable 不算违规', () => {
    const result = scanReadOnlyCompliance([
      { path: 'ok.tsx', content: '// 这里不使用 contentEditable，也不放 <textarea>\nconst a = { readOnly: true };\n' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('静态扫描能识别各种违规写法（反例）', () => {
    const cases: { name: string; content: string; rule: string }[] = [
      { name: 'contentEditable', content: '<pre readOnly contentEditable>code</pre>', rule: 'contentEditable' },
      { name: 'textarea', content: '<textarea readOnly />', rule: 'textarea' },
      { name: 'input', content: '<input readOnly />', rule: 'input' },
      { name: 'onChange 写回', content: 'const x = readOnly; onChange={save}', rule: 'writeback-handler' },
      { name: 'readOnly=false', content: 'readOnly={false}', rule: 'readOnly-false' },
      { name: 'designMode', content: 'document.designMode = "on"; // readOnly', rule: 'designMode' },
      { name: '缺只读标记', content: 'export function CodeView() { return null; }', rule: 'missing-readonly-marker' },
    ];

    for (const item of cases) {
      const result = scanReadOnlyCompliance([{ path: `${item.name}.tsx`, content: item.content }]);
      expect(result.ok, `${item.name} 应被判定为违规`).toBe(false);
      expect(result.violations.map((violation) => violation.rule)).toContain(item.rule);
    }
  });

  it('contentEditable={false} 属于允许写法（显式关闭）', () => {
    const result = scanReadOnlyCompliance([
      { path: 'ok.tsx', content: '<pre readOnly contentEditable={false}>x</pre>' },
    ]);
    expect(result.ok).toBe(true);
  });
});
