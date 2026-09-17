import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createElement } from '../../dsl/factory';
import { ComponentRegistry } from '../../registry/component-registry';
import { getIcon, iconNames } from '../../registry/icon-set';
import { schemaDefaults, validatePropSchema } from '../../registry/prop-schema';
import { BUILTIN_COMPONENT_METAS, registerBuiltinComponents } from '../index';

/** 组件白名单（T3-04 产出：12 基础 + 3 业务） */
const BASIC = [
  'Container',
  'Text',
  'Image',
  'Button',
  'Input',
  'Select',
  'Table',
  'List',
  'Form',
  'Modal',
  'Tabs',
  'Navbar',
];
const BUSINESS = ['LoginCard', 'DashboardTemplate', 'ListPageTemplate'];
const ALL = [...BASIC, ...BUSINESS];

/** 不接受子节点的组件（PRD FR-DSG-03 嵌套规则） */
const LEAF_TYPES = ['Button', 'Text', 'Image', 'Input', 'Select'];

function freshRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registerBuiltinComponents(registry);
  return registry;
}

describe('T3-04 组件库清单', () => {
  it('重复装配内置组件不会覆盖已注册项或导致页面热更新崩溃', () => {
    const registry = freshRegistry();
    const original = registry.get('Container');
    expect(() => registerBuiltinComponents(registry)).not.toThrow();
    expect(registry.types()).toHaveLength(ALL.length);
    expect(registry.get('Container')).toBe(original);
  });
  it('注册 12 类基础组件 + 3 类业务组件', () => {
    const registry = freshRegistry();
    expect(registry.types().sort()).toEqual([...ALL].sort());
    // 基础组件按语义分散在「基础 / 布局 / 表单 / 数据展示」等分组，业务组件单独成组
    const groups = new Set(registry.groups().map((group) => group.group));
    expect([...groups]).toEqual(expect.arrayContaining(['基础', '业务组件']));
    for (const type of BASIC) expect(registry.get(type)?.group).not.toBe('业务组件');
  });

  it('每个组件都有中文显示名、默认 props/style 与图标', () => {
    const registry = freshRegistry();
    for (const type of ALL) {
      const meta = registry.get(type);
      expect(meta, `${type} 未注册`).not.toBeNull();
      expect(meta?.displayName.length).toBeGreaterThan(0);
      expect(meta?.displayName).not.toBe(type); // 显示名必须是中文，不能用英文类型名充当（D-10）
      expect(meta?.defaultProps).toBeTypeOf('object');
      expect(meta?.defaultStyle).toBeTypeOf('object');
      expect(iconNames()).toContain(meta?.icon as string);
    }
  });

  it('多路径图标渲染时不会产生缺少 key 的 React 告警', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<>{getIcon('container')}</>);
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('Each child in a list should have a unique "key" prop'),
    );
  });

  it('业务组件归入「业务组件」分组', () => {
    const registry = freshRegistry();
    for (const type of BUSINESS) {
      expect(registry.get(type)?.group).toBe('业务组件');
    }
  });

  it('组件面板按分组列出全部组件', () => {
    const registry = freshRegistry();
    const groups = registry.groups();
    const listed = groups.flatMap((group) => group.components.map((meta) => meta.type));
    expect(listed.sort()).toEqual([...ALL].sort());
    expect(groups.map((group) => group.group)).toContain('业务组件');
  });
});

describe('T3-04 属性 JSON Schema', () => {
  it('15 类组件的 schema 全部通过自检', () => {
    const registry = freshRegistry();
    for (const type of ALL) {
      const meta = registry.get(type);
      expect(validatePropSchema(meta!.propSchema), `${type} schema 有问题`).toEqual([]);
    }
  });

  it('关键组件的 schema 覆盖任务卡要求的字段', () => {
    const registry = freshRegistry();
    const keys = (type: string): string[] =>
      registry.get(type)!.propSchema.fields.map((field) => field.key);
    expect(keys('Button')).toEqual(
      expect.arrayContaining(['text', 'variant', 'block', 'disabled']),
    );
    expect(keys('Input')).toEqual(expect.arrayContaining(['placeholder', 'required']));
    expect(keys('Select')).toEqual(expect.arrayContaining(['options', 'multiple']));
    expect(keys('Table')).toEqual(expect.arrayContaining(['columns', 'pageSize']));
    expect(keys('Modal')).toEqual(expect.arrayContaining(['title', 'width', 'maskClosable']));
    expect(keys('Tabs')).toEqual(expect.arrayContaining(['items', 'position']));
  });

  it('枚举字段带中文选项，分组成员落在合法分组内', () => {
    const registry = freshRegistry();
    const meta = registry.get('Button')!;
    const variant = meta.propSchema.fields.find((field) => field.key === 'variant')!;
    expect(variant.type).toBe('enum');
    expect(variant.options?.length).toBeGreaterThan(0);
    for (const option of variant.options ?? []) expect(option.label.length).toBeGreaterThan(0);
  });

  it('schemaDefaults 给出可直接落地的默认 props', () => {
    const registry = freshRegistry();
    const defaults = schemaDefaults(registry.get('Button')!.propSchema);
    expect(Object.keys(defaults).length).toBeGreaterThan(0);
  });
});

describe('T3-04 嵌套规则', () => {
  it('叶子组件不接受 children，容器型组件接受', () => {
    const registry = freshRegistry();
    for (const type of LEAF_TYPES) {
      expect(registry.acceptsChildren(type), `${type} 不应接受 children`).toBe(false);
    }
    for (const type of ['Container', 'Form', 'Modal', 'Tabs', 'List', 'Table', 'Navbar']) {
      expect(registry.acceptsChildren(type), `${type} 应接受 children`).toBe(true);
    }
  });

  it('未注册组件按容器处理（避免拖拽被无谓拒绝）', () => {
    const registry = freshRegistry();
    expect(registry.acceptsChildren('NotRegistered')).toBe(true);
  });
});

describe('T3-04 组件渲染（纯受控展示）', () => {
  it('15 类组件在设计态均可渲染', () => {
    const registry = freshRegistry();
    for (const type of ALL) {
      const renderer = registry.rendererFor(type);
      expect(renderer, `${type} 缺少渲染器`).not.toBeNull();
      const node = {
        ...createElement({ id: `n-${type}`, type }),
        props: { ...registry.get(type)!.defaultProps },
      };
      const Renderer = renderer as NonNullable<typeof renderer>;
      const { container, unmount } = render(
        <Renderer node={node} mode="design">
          <span>子内容</span>
        </Renderer>,
      );
      expect(container.firstChild).not.toBeNull();
      unmount();
    }
  });

  it('设计态：空值是占位提示而不是空白', () => {
    const registry = freshRegistry();
    const Renderer = registry.rendererFor('Image')!;
    render(
      <Renderer node={createElement({ id: 'img', type: 'Image' })} mode="design">
        <span />
      </Renderer>,
    );
    expect(screen.getAllByText(/图片|暂无|占位/).length).toBeGreaterThan(0);
  });

  it('预览态：按 scope 解析绑定值', () => {
    const registry = freshRegistry();
    const Renderer = registry.rendererFor('Text')!;
    const node = {
      ...createElement({ id: 'txt', type: 'Text', props: { text: '' } }),
      bindings: { text: '${user.name}' },
    };
    render(<Renderer node={node} mode="preview" scope={{ user: { name: '小吴' } }} />);
    expect(screen.getByText('小吴')).toBeInTheDocument();
  });

  it('组件元信息与默认 props 不含函数（保证可序列化进 DSL）', () => {
    for (const meta of BUILTIN_COMPONENT_METAS) {
      expect(() => JSON.stringify(meta.defaultProps)).not.toThrow();
      expect(() => JSON.stringify(meta.defaultStyle)).not.toThrow();
      expect(() => JSON.stringify(meta.propSchema)).not.toThrow();
    }
  });
});

describe('T3-04 自定义组件注册', () => {
  it('运行时注册的自定义组件出现在面板且可查询', () => {
    const registry = freshRegistry();
    const CustomRenderer = (): JSX.Element => <div data-component="MyCard" />;
    registry.register({
      meta: {
        type: 'MyCard',
        displayName: '我的卡片',
        group: '自定义',
        icon: 'image',
        defaultProps: { title: '自定义标题' },
        defaultStyle: {},
        acceptsChildren: true,
        propSchema: {
          fields: [
            { key: 'title', label: '标题', type: 'text', group: '内容', default: '自定义标题' },
            { key: 'bordered', label: '显示边框', type: 'boolean', group: '外观', default: true },
          ],
        },
      },
      renderer: CustomRenderer,
    });

    expect(registry.has('MyCard')).toBe(true);
    expect(registry.list('自定义').map((meta) => meta.type)).toEqual(['MyCard']);
    expect(registry.groups().map((group) => group.group)).toContain('自定义');
    expect(registry.rendererFor('MyCard')).toBe(CustomRenderer);
    expect(validatePropSchema(registry.get('MyCard')!.propSchema)).toEqual([]);
  });
});
