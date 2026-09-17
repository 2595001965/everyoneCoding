import { describe, it, expect } from 'vitest';

import {
  PROJECT_TEMPLATES,
  TEMPLATE_COMPONENT_TYPES,
  countTemplateElements,
  findTemplate,
  validateTemplate,
  type ProjectTemplate,
  type TemplateElement,
} from '../project-templates';

function flatten(elements: readonly TemplateElement[]): TemplateElement[] {
  const out: TemplateElement[] = [];
  for (const element of elements) {
    out.push(element);
    if (element.children) out.push(...flatten(element.children));
  }
  return out;
}

describe('内置项目模板', () => {
  it('恰好三套：Web 管理后台 / 移动端 App / 官网落地页', () => {
    expect(PROJECT_TEMPLATES).toHaveLength(3);
    expect(PROJECT_TEMPLATES.map((t) => t.id)).toEqual(['tpl-web-admin', 'tpl-mobile-app', 'tpl-landing']);
    expect(findTemplate('tpl-mobile-app')?.name).toBe('移动端 App');
    expect(findTemplate('不存在')).toBeNull();
  });

  it('每套模板都通过一致性自检（组件类型必须在 15 类库内）', () => {
    for (const template of PROJECT_TEMPLATES) {
      expect(validateTemplate(template), `${template.name} 自检失败`).toEqual([]);
    }
  });

  it('每套模板含初始页面（带路由）与项目记忆草稿', () => {
    for (const template of PROJECT_TEMPLATES) {
      expect(template.pages.length).toBeGreaterThan(0);
      expect(template.memoryDrafts.length).toBeGreaterThan(0);
      expect(template.memoryDrafts.some((draft) => draft.scope === 'project')).toBe(true);
      for (const page of template.pages) {
        expect(page.route.startsWith('/')).toBe(true);
        expect(page.note.length).toBeGreaterThan(0);
      }
    }
  });

  it('模板目标端与页面 platform 一致，技术方案取 FR-AI-13 矩阵值', () => {
    const allowedValues = new Set(['react', 'vue3', 'flutter', 'react-native', 'native', 'arkts', 'tauri2', 'electron', 'qt']);
    for (const template of PROJECT_TEMPLATES) {
      for (const platform of template.targetPlatforms) {
        const value = template.techStack[platform];
        expect(value, `${template.name} 缺少 ${platform} 的技术方案`).toBeDefined();
        expect(allowedValues.has(value!)).toBe(true);
      }
    }
    expect(findTemplate('tpl-mobile-app')?.targetPlatforms).toEqual(['android', 'ios']);
    expect(findTemplate('tpl-web-admin')?.targetPlatforms).toEqual(['web']);
  });

  it('Web 管理后台模板元素数 ≥ 15（可支撑设计器演示）', () => {
    const admin = findTemplate('tpl-web-admin')!;
    expect(countTemplateElements(admin)).toBeGreaterThanOrEqual(15);
  });

  it('自检能抓出未注册组件类型与非 / 开头路由', () => {
    const broken: ProjectTemplate = {
      id: 'tpl-broken',
      name: '坏模板',
      description: '',
      targetPlatforms: ['web'],
      techStack: { web: 'react' },
      pages: [
        {
          name: '坏页面',
          route: 'no-slash',
          platform: 'web',
          note: 'x',
          elements: [{ type: 'MagicWidget', name: 'w', props: {} }],
        },
      ],
      memoryDrafts: [{ scope: 'project', title: 't', content: 'c', tags: [] }],
    };
    const issues = validateTemplate(broken);
    expect(issues.some((issue) => issue.includes('MagicWidget'))).toBe(true);
    expect(issues.some((issue) => issue.includes('路由必须以 / 开头'))).toBe(true);
  });

  it('空模板（无页面/无记忆）自检报警', () => {
    const empty: ProjectTemplate = {
      id: 'tpl-empty',
      name: '空模板',
      description: '',
      targetPlatforms: ['web'],
      techStack: { web: 'react' },
      pages: [],
      memoryDrafts: [],
    };
    const issues = validateTemplate(empty);
    expect(issues.some((issue) => issue.includes('至少需要一个页面'))).toBe(true);
    expect(issues.some((issue) => issue.includes('至少需要一条项目记忆草稿'))).toBe(true);
  });
});

describe('模板组件库白名单', () => {
  it('15 类组件类型无重复、全部为非空英文标识符', () => {
    expect(TEMPLATE_COMPONENT_TYPES).toHaveLength(15);
    expect(new Set(TEMPLATE_COMPONENT_TYPES).size).toBe(15);
    for (const type of TEMPLATE_COMPONENT_TYPES) {
      expect(/^[A-Z][A-Za-z]*$/.test(type), `${type} 应为英文大驼峰`).toBe(true);
    }
  });

  it('三套模板用到的全部元素类型都在白名单内', () => {
    const allowed = new Set<string>(TEMPLATE_COMPONENT_TYPES);
    const used = new Set<string>();
    for (const template of PROJECT_TEMPLATES) {
      for (const page of template.pages) {
        for (const element of flatten(page.elements)) used.add(element.type);
      }
    }
    expect(used.size).toBeGreaterThanOrEqual(8);
    for (const type of used) expect(allowed.has(type), `${type} 不在白名单`).toBe(true);
  });
});
