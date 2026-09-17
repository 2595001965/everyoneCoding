/**
 * 页面 DSL 类型定义（PRD §M3 的 PageDSL / ElementNode）。
 *
 * 注意：正式的 PageDSL 应由 `@ec/designer` 提供（Wave 3 设计器落地后）。
 * 当前设计器尚未实现，故在本目录内先行定义并导出同名类型，
 * 形状严格对齐 PRD §M3，并在注释中标注，以便 Wave 3 时直接替换、无需改动上层逻辑。
 *
 * 替换方式：Wave 3 后将本文件的接口改为
 *   `export type { PageDsl, PageDslElement, ... } from '@ec/designer';`
 * 即可，condenser 其余模块只依赖这里导出的类型名，不依赖实现。
 */

/** 页面级状态（变量）定义 */
export interface PageDslState {
  name: string;
  type: string;
  initial?: unknown;
  source?: 'local' | 'api';
}

/** 事件动作（跳转 / 请求 / 赋值 / 提示 / 条件分支） */
export interface PageDslAction {
  kind: 'navigate' | 'request' | 'assign' | 'notify' | 'branch';
  target?: string;
  value?: unknown;
}

/** 事件：触发器 + 动作序列 */
export interface PageDslEvent {
  id: string;
  trigger: string;
  actions: PageDslAction[];
}

/** 组件节点（递归树） */
export interface PageDslElement {
  id: string;
  type: string;
  name?: string;
  props?: Record<string, unknown>;
  style?: Record<string, unknown>;
  /** 属性 → 状态/接口字段 的绑定 */
  bindings?: Record<string, string>;
  /** 关联的功能 id（分层沉淀用） */
  featureRef?: string | null;
  children?: PageDslElement[];
  noteId?: string;
}

/** 页面 DSL 完整结构 */
export interface PageDsl {
  id: string;
  projectId: string;
  name: string;
  platform: 'web' | 'android' | 'ios' | 'harmonyos' | 'windows' | 'linux' | 'macos';
  route: string;
  featureId?: string | null;
  viewport?: { width: number; height: number };
  state?: PageDslState[];
  tree: PageDslElement;
  events?: PageDslEvent[];
  apiDeps?: string[];
}

/**
 * 登录页 DSL 夹具：恰好 20 个元素，贴合 PRD §13.1 的登录页示例。
 *
 * 结构：Container
 *   ├─ NavBar [Logo, NavLink]
 *   ├─ Card [Logo, Title, Subtitle, Form[Input(phone), Input(password), Icon(eye), Checkbox(remember), Text(error), Button(submit)], Links[Link(register), Link(forgot)]]
 *   └─ Footer [Text(copyright)]
 *
 * 该夹具供单测与后续 Wave（设计器联调、保真度评估）直接复用。
 */
export function createLoginPageDslFixture(): PageDsl {
  return {
    id: 'el-root',
    projectId: 'P1',
    name: '登录页',
    platform: 'web',
    route: '/login',
    featureId: 'F1',
    viewport: { width: 1440, height: 900 },
    state: [
      { name: 'phone', type: 'string', source: 'local' },
      { name: 'password', type: 'string', source: 'local' },
      { name: 'remember', type: 'boolean', source: 'local', initial: false },
      { name: 'loading', type: 'boolean', source: 'local' },
      { name: 'errorMsg', type: 'string', source: 'local' },
    ],
    tree: {
      id: 'el-root',
      type: 'Container',
      name: 'page',
      children: [
        {
          id: 'el-nav',
          type: 'NavBar',
          name: 'nav',
          children: [
            { id: 'el-nav-logo', type: 'Logo', name: 'brand' },
            { id: 'el-nav-link', type: 'NavLink', name: 'home', props: { text: '首页', href: '/' } },
          ],
        },
        {
          id: 'el-card',
          type: 'Card',
          name: 'loginCard',
          children: [
            { id: 'el-logo', type: 'Logo', name: 'logo' },
            { id: 'el-title', type: 'Title', name: 'title', props: { text: '欢迎登录' } },
            { id: 'el-subtitle', type: 'Text', name: 'subtitle', props: { text: '使用手机号登录你的账号' } },
            {
              id: 'el-form',
              type: 'Form',
              name: 'loginForm',
              featureRef: 'F1',
              children: [
                {
                  id: 'el-phone',
                  type: 'Input',
                  name: 'phone',
                  featureRef: 'F1',
                  props: { placeholder: '请输入手机号', type: 'tel', name: 'phone', required: true },
                  bindings: { value: 'phone' },
                },
                {
                  id: 'el-password',
                  type: 'Input',
                  name: 'password',
                  featureRef: 'F1',
                  props: { placeholder: '请输入密码', type: 'password', name: 'password', required: true },
                  bindings: { value: 'password' },
                },
                { id: 'el-eye', type: 'Icon', name: 'eye', props: { name: 'eye' } },
                {
                  id: 'el-remember',
                  type: 'Checkbox',
                  name: 'remember',
                  featureRef: 'F1',
                  props: { label: '记住登录', name: 'remember' },
                  bindings: { checked: 'remember' },
                },
                {
                  id: 'el-error',
                  type: 'Text',
                  name: 'error',
                  props: { text: '' },
                  bindings: { text: 'errorMsg' },
                },
                {
                  id: 'el-submit',
                  type: 'Button',
                  name: 'submit',
                  featureRef: 'F1',
                  props: { text: '登录', type: 'submit' },
                  bindings: { disabled: 'loading' },
                },
              ],
            },
            {
              id: 'el-links',
              type: 'Links',
              name: 'links',
              children: [
                {
                  id: 'el-register',
                  type: 'Link',
                  name: 'register',
                  featureRef: 'F2',
                  props: { text: '注册账号', href: '/register' },
                },
                {
                  id: 'el-forgot',
                  type: 'Link',
                  name: 'forgot',
                  featureRef: 'F1',
                  props: { text: '忘记密码', href: '/forgot' },
                },
              ],
            },
          ],
        },
        {
          id: 'el-footer',
          type: 'Footer',
          name: 'footer',
          children: [{ id: 'el-copyright', type: 'Text', name: 'copyright', props: { text: '© 2026 EveryoneCoding' } }],
        },
      ],
    },
    events: [
      {
        id: 'ev-submit',
        trigger: 'submit.click',
        actions: [
          { kind: 'assign', value: 'loading=true' },
          { kind: 'request', target: '/api/auth/login' },
          { kind: 'branch', target: 'success' },
          { kind: 'navigate', target: '/dashboard' },
          { kind: 'assign', value: 'errorMsg' },
          { kind: 'notify', value: '登录失败，请重试' },
        ],
      },
    ],
    apiDeps: ['/api/auth/login'],
  };
}
