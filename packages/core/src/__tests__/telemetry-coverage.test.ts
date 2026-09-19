/**
 * 埋点覆盖率报告（T10-01 验收项）。
 *
 * 以「关键路径清单 → 事件」映射表为分母，逐路径核对 KEY_EVENT_NAMES 是否
 * 存在对应事件，并断言整体覆盖率 ≥90%（NFR-M-02）。
 *
 * 运行时把覆盖率数据 process.stdout.write 出来（console.info 会被 vitest 拦截），
 * 供 docs/TEST-REPORT.md 引用。
 */

import { describe, expect, it } from 'vitest';

import { KEY_EVENT_NAMES } from '../telemetry-events';

/** 关键路径清单（任务卡列举的类别 × 代表路径） */
const KEY_PATHS: Array<{ category: string; paths: string[]; events: string[] }> = [
  {
    category: '项目生命周期',
    paths: [
      '新建项目',
      '打开项目',
      '删除项目',
      '归档',
      '恢复',
      '复制',
      'Git 导入',
      '文档导入',
      '模板创建',
    ],
    events: [
      'project.create',
      'project.open',
      'project.delete',
      'project.archive',
      'project.restore',
      'project.duplicate',
      'project.import_git',
      'project.import_doc',
      'project.create_template',
    ],
  },
  {
    category: '流水线',
    paths: ['阶段推进', '阶段回退', '阶段确认', '生成开始', '生成结束', '崩溃恢复'],
    events: [
      'pipeline.stage_advance',
      'pipeline.stage_rollback',
      'pipeline.stage_confirm',
      'pipeline.generate_start',
      'pipeline.generate_end',
      'pipeline.recovery_restore',
    ],
  },
  {
    category: '设计器',
    paths: ['建页面', '保存页面', 'AI 生成界面'],
    events: ['designer.page_create', 'designer.page_save', 'designer.ai_generate'],
  },
  {
    category: '记忆',
    paths: ['自动抽取', '提示卡建卡', '问题记忆生效'],
    events: ['memory.capture', 'memory.promotion', 'memory.question_resolve'],
  },
  {
    category: 'Git',
    paths: ['初始化', '提交', '推送', '建分支', '合并', '回滚'],
    events: [
      'git.init',
      'git.commit',
      'git.push',
      'git.branch_create',
      'git.merge',
      'git.rollback',
    ],
  },
  {
    category: '统一重命名',
    paths: ['重命名事务', '撤销'],
    events: ['rename.transaction', 'rename.undo'],
  },
  {
    category: '归档迁移',
    paths: ['导出', '导入', '定时备份'],
    events: ['package.export', 'package.import', 'package.backup'],
  },
  {
    category: '账号',
    paths: ['登录', '登出', '绑定', '解绑'],
    events: ['auth.login', 'auth.logout', 'auth.bind', 'auth.unbind'],
  },
  {
    category: 'AI 与更新',
    paths: ['AI 请求', '更新检查', '更新应用', '错误'],
    events: ['ai.request', 'app.update_check', 'app.update_apply', 'app.error'],
  },
];

describe('埋点覆盖率（NFR-M-02 ≥90%）', () => {
  it('关键路径事件映射表与 KEY_EVENT_NAMES 一一对应', () => {
    for (const group of KEY_PATHS) {
      expect(group.paths).toHaveLength(group.events.length);
    }
  });

  it('覆盖率 ≥ 90% 并输出报告', () => {
    const declared = new Set<string>(KEY_EVENT_NAMES);
    let covered = 0;
    let total = 0;
    const missing: string[] = [];
    for (const group of KEY_PATHS) {
      for (const event of group.events) {
        total += 1;
        if (declared.has(event)) covered += 1;
        else missing.push(`${group.category}:${event}`);
      }
    }
    const ratio = total === 0 ? 0 : covered / total;
    process.stdout.write(
      `\n[埋点覆盖率] 关键路径事件 ${covered}/${total} = ${(ratio * 100).toFixed(1)}%（${missing.length === 0 ? '无缺口' : `缺口: ${missing.join(', ')}`}）\n`,
    );
    expect(ratio).toBeGreaterThanOrEqual(0.9);
    expect(missing).toEqual([]);
  });

  it('KEY_EVENT_NAMES 无重复登记', () => {
    const names = [...KEY_EVENT_NAMES];
    expect(new Set(names).size).toBe(names.length);
  });
});
