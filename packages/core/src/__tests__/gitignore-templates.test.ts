import { describe, expect, it } from 'vitest';
import { GITIGNORE_TEMPLATES, getTemplate, renderGitignore } from '../gitignore-templates';

describe('.gitignore 模板', () => {
  it('提供 6 套技术栈模板', () => {
    expect(GITIGNORE_TEMPLATES).toHaveLength(6);
    for (const id of ['node', 'python', 'java', 'go', 'flutter', 'harmonyos-arkts'] as const) {
      expect(getTemplate(id).body.length).toBeGreaterThan(50);
    }
  });

  it('HarmonyOS-ArkTS 覆盖 hvigor 与 oh_modules 产物', () => {
    const template = getTemplate('harmonyos-arkts');
    expect(template.body).toContain('.hvigor/');
    expect(template.body).toContain('oh_modules/');
    expect(template.body).toContain('build/');
    expect(template.body).toContain('**/oh_modules/');
    expect(template.body).toContain('*.hap');
  });

  it('Node 模板忽略 node_modules 与环境变量', () => {
    const template = getTemplate('node');
    expect(template.body).toContain('node_modules/');
    expect(template.body).toContain('.env');
  });

  it('多栈组合生成，含 EveryoneCoding 固定段', () => {
    const content = renderGitignore(['node', 'harmonyos-arkts']);
    expect(content).toContain('# ---- Node.js ----');
    expect(content).toContain('# ---- HarmonyOS（ArkTS） ----');
    expect(content).toContain('.ecpkg');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('可关闭 EC 固定段并追加自定义规则', () => {
    const content = renderGitignore(['go'], { includeEcSection: false, extra: ['my-ignored-dir/'] });
    expect(content).not.toContain('.ecpkg');
    expect(content).toContain('my-ignored-dir/');
    expect(content).toContain('# ---- Go ----');
  });

  it('未知栈直接报错而非静默跳过', () => {
    // @ts-expect-error 故意传入非法栈以验证运行时校验
    expect(() => getTemplate('ruby')).toThrow(/未知/);
  });
});
