import { describe, it, expect } from 'vitest';

import { parseRequirementDocument, projectNameFromDigest } from '../doc-import';

const SAMPLE = `# 在线课程平台需求文档

本文档描述在线课程平台的第一版功能范围。

## 1. 功能需求

- 课程管理：支持课程的创建、编辑、上下架，上下架操作需二次确认
- 用户注册登录：支持邮箱注册与第三方登录，密码不少于 8 位
- 学习进度：记录每个用户的学习进度并支持续播
- 课程搜索：按标题、讲师、分类检索，支持结果高亮

## 2. 页面清单

- 首页 /home
- 课程详情页
- 个人中心

## 3. 非功能需求

- 首页首屏加载时间不超过 1 秒
- 所有接口必须做权限校验

## 4. 其他说明

这里是一些补充说明，不属于功能清单。
`;

describe('需求文档解析（Markdown）', () => {
  it('提取标题与功能清单（名称/描述/行号/所属章节）', () => {
    const digest = parseRequirementDocument(SAMPLE);
    expect(digest.title).toBe('在线课程平台需求文档');
    expect(digest.features.map((f) => f.name)).toEqual([
      '课程管理',
      '用户注册登录',
      '学习进度',
      '课程搜索',
    ]);
    expect(digest.features[0]!.description).toContain('二次确认');
    expect(digest.features[0]!.section).toBe('1. 功能需求');
    expect(digest.features[0]!.line).toBeGreaterThan(0);
  });

  it('提取页面候选并生成路由占位', () => {
    const digest = parseRequirementDocument(SAMPLE);
    expect(digest.pageCandidates.map((p) => p.name)).toEqual(['首页', '课程详情页', '个人中心']);
    expect(digest.pageCandidates[0]!.route).toBe('/home');
    expect(digest.pageCandidates[1]!.route).toBe('/page-2');
  });

  it('提取非功能需求，且不混入功能清单', () => {
    const digest = parseRequirementDocument(SAMPLE);
    expect(digest.nonFunctional).toHaveLength(2);
    expect(digest.nonFunctional[0]).toContain('1 秒');
    expect(digest.features.some((f) => f.name.includes('首屏'))).toBe(false);
  });

  it('生成项目记忆草稿（功能范围 + 非功能约束）', () => {
    const digest = parseRequirementDocument(SAMPLE);
    const scope = digest.memoryDrafts.find((d) => d.title.includes('功能范围'));
    expect(scope?.content).toContain('- 课程管理');
    expect(scope?.tags).toContain('需求');
    expect(digest.memoryDrafts.some((d) => d.title.includes('非功能约束'))).toBe(true);
  });

  it('无告警、summary 汇总数量', () => {
    const digest = parseRequirementDocument(SAMPLE);
    expect(digest.warnings).toEqual([]);
    expect(digest.summary).toContain('4 项功能');
    expect(digest.summary).toContain('3 个页面候选');
  });

  it('表格形式的功能清单同样被识别（表头含"功能"）', () => {
    const tableDoc = `# 系统需求

## 功能列表

| 功能名称 | 说明 | 优先级 |
| --- | --- | --- |
| 订单创建 | 支持多商品下单 | P0 |
| 订单取消 | 支持取消未支付订单 | P1 |
`;
    const digest = parseRequirementDocument(tableDoc);
    expect(digest.features.map((f) => f.name)).toEqual(['订单创建', '订单取消']);
    expect(digest.features[0]!.description).toContain('多商品');
  });

  it('编号列表、加粗、反引号与链接被正确清洗', () => {
    const doc = `# 需求

## 功能
1. **数据导出**：导出 \`xlsx\`
2. [批量删除](https://x) 支持多选
`;
    const digest = parseRequirementDocument(doc);
    expect(digest.features.map((f) => f.name)).toEqual(['数据导出', '批量删除']);
    expect(digest.features[0]!.description).toBe('导出 xlsx');
  });

  it('功能名去重（同名只保留首次）', () => {
    const doc = `# X

## 功能
- 登录：邮箱
- 登录：手机号
- 注册
`;
    const digest = parseRequirementDocument(doc);
    expect(digest.features.map((f) => f.name)).toEqual(['登录', '注册']);
  });

  it('超长名称截断为 40 字 + 省略号', () => {
    const long = 'A'.repeat(80);
    const digest = parseRequirementDocument(`# X\n\n## 功能\n- ${long}\n`);
    expect(digest.features[0]!.name.length).toBe(41);
    expect(digest.features[0]!.name.endsWith('…')).toBe(true);
  });

  it('无功能清单时给出可操作告警，不产出空项目', () => {
    const digest = parseRequirementDocument('# 只有标题\n\n随便一段说明文字。\n');
    expect(digest.features).toEqual([]);
    expect(digest.warnings.some((w) => w.includes('未在文档中识别到功能清单'))).toBe(true);
    expect(digest.memoryDrafts[0]!.content).toContain('待补充');
  });

  it('无 H1 时用首个非空段落作标题并给出告警', () => {
    const digest = parseRequirementDocument('\n\n客户管理系统\n\n## 功能\n- 客户建档\n');
    expect(digest.title).toBe('客户管理系统');
    const noTitle = parseRequirementDocument('## 功能\n- a\n');
    expect(noTitle.title).toBe('导入的需求文档');
    expect(noTitle.warnings.some((w) => w.includes('未识别到文档标题'))).toBe(true);
  });

  it('功能数超上限时截断并告警', () => {
    const lines = ['# X', '', '## 功能'];
    for (let i = 0; i < 12; i += 1) lines.push(`- 功能${i}`);
    const digest = parseRequirementDocument(lines.join('\n'), { maxFeatures: 5 });
    expect(digest.features).toHaveLength(5);
    expect(digest.warnings.some((w) => w.includes('已截断'))).toBe(true);
  });

  it('CRLF 换行同样可解析', () => {
    const digest = parseRequirementDocument('# X\r\n\r\n## 功能\r\n- 登录\r\n- 注册\r\n');
    expect(digest.features.map((f) => f.name)).toEqual(['登录', '注册']);
  });

  it('从摘要推断项目名（去掉"需求文档"等后缀）', () => {
    const digest = parseRequirementDocument(SAMPLE);
    expect(projectNameFromDigest(digest)).toBe('在线课程平台');
    expect(projectNameFromDigest({ ...digest, title: '' })).toBe('新建项目');
  });
});
