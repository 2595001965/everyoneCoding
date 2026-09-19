import {
  isMobilePlatform,
  type ElementNode,
  type EventDef,
  type PageDsl,
  type PageStateVar,
  type Platform,
  type Viewport,
} from './types';

/**
 * PageDSL 构造工厂（T3-01）。
 *
 * 提供：
 * - 确定性 / 随机 id 工厂（测试用确定性，运行期用带时间片前缀的短 id）
 * - 元素与页面构造器，自动补齐可选字段，降低各处拼接 DSL 的出错面
 * - `createLoginPageDsl()`：**恰好 20 个元素**的登录页样例，供 E2E-04 与
 *   下游任务（精简、代码生成、快照）直接复用
 */

/** 顺序 id 工厂：`el-1`、`el-2`…（测试与快照对比用，保证可复现） */
export function createSequentialIdFactory(prefix = 'el', start = 1): () => string {
  let counter = start;
  return () => {
    const id = `${prefix}-${counter}`;
    counter += 1;
    return id;
  };
}

/** 随机 id 工厂：`el-<时间片><随机>`，运行期使用 */
export function createRandomIdFactory(prefix = 'el'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const time = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 7);
    return `${prefix}-${time}${counter.toString(36)}${random}`;
  };
}

/** 各平台默认视口 */
export function defaultViewportFor(platform: Platform): Viewport {
  switch (platform) {
    case 'android':
      return { width: 360, height: 800, presetId: 'android-360x800' };
    case 'ios':
      return { width: 390, height: 844, presetId: 'ios-390x844' };
    case 'harmonyos':
      return { width: 360, height: 780, presetId: 'harmony-360x780' };
    case 'windows':
    case 'linux':
    case 'macos':
      return { width: 1440, height: 900, presetId: `${platform}-1440x900` };
    default:
      return { width: 1440, height: 900, presetId: 'web-1440' };
  }
}

export interface CreateElementInput {
  id: string;
  type: string;
  name?: string;
  props?: Record<string, unknown>;
  style?: Record<string, unknown>;
  bindings?: Record<string, string>;
  children?: ElementNode[];
  noteId?: string | null;
  featureRef?: string | null;
  locked?: boolean;
  hidden?: boolean;
}

/** 构造元素节点；可选字段仅在提供时写入，保持序列化结果精简 */
export function createElement(input: CreateElementInput): ElementNode {
  const node: ElementNode = { id: input.id, type: input.type };
  if (input.name !== undefined) node.name = input.name;
  if (input.props !== undefined) node.props = input.props;
  if (input.style !== undefined) node.style = input.style;
  if (input.bindings !== undefined) node.bindings = input.bindings;
  if (input.children !== undefined) node.children = input.children;
  if (input.noteId !== undefined) node.noteId = input.noteId;
  if (input.featureRef !== undefined) node.featureRef = input.featureRef;
  if (input.locked !== undefined) node.locked = input.locked;
  if (input.hidden !== undefined) node.hidden = input.hidden;
  return node;
}

export interface CreatePageDslInput {
  id: string;
  projectId: string;
  name: string;
  platform: Platform;
  route: string;
  featureId?: string | null;
  viewport?: Viewport;
  state?: PageStateVar[];
  tree?: ElementNode;
  events?: EventDef[];
  apiDeps?: string[];
}

/** 构造完整 PageDsl（数组类字段一律给空数组，避免各处判空） */
export function createPageDsl(input: CreatePageDslInput): PageDsl {
  const page: PageDsl = {
    id: input.id,
    projectId: input.projectId,
    name: input.name,
    platform: input.platform,
    route: input.route,
    viewport: input.viewport ?? defaultViewportFor(input.platform),
    state: input.state ?? [],
    tree: input.tree ?? createElement({ id: `${input.id}-root`, type: 'Container', name: '页面' }),
    events: input.events ?? [],
    apiDeps: input.apiDeps ?? [],
    notes: [],
    anchors: {},
  };
  if (input.featureId !== undefined) page.featureId = input.featureId;
  return page;
}

/** 空白页：一个根容器 */
export function createEmptyPage(options: {
  id: string;
  projectId: string;
  name?: string;
  platform?: Platform;
  route?: string;
}): PageDsl {
  const platform = options.platform ?? 'web';
  return createPageDsl({
    id: options.id,
    projectId: options.projectId,
    name: options.name ?? '新页面',
    platform,
    route: options.route ?? `/${options.id}`,
    tree: createElement({ id: `${options.id}-root`, type: 'Container', name: '页面' }),
  });
}

/**
 * 登录页样例 DSL：**恰好 20 个元素**。
 *
 * ```
 * Container 页面
 *  ├ Navbar 导航栏             → Image 站点标识 / Text 首页链接
 *  ├ Container 登录卡片        → Image 品牌标识 / Text 标题 / Text 副标题
 *  │                            / Form 登录表单
 *  │                                ├ Input 手机号 / Input 密码 / Image 密码可见切换
 *  │                                ├ Input 记住登录 / Text 错误提示
 *  │                                └ Button 登录按钮
 *  │                            / Container 辅助链接组 → Text 注册 / Text 忘记密码
 *  └ Container 页脚            → Text 版权信息
 * ```
 *
 * 约束：所用类型**必须全部来自 `@ec/components` 的 15 类内置组件**，
 * 否则「从组件面板拖出 20 元素登录页」（Wave 3 出口检查 E2E-04）不成立。
 * 链接 / 图标一类语义用 `Text`（props.href）/ `Image` 表达，避免把组件库撑成非约定的规模。
 */
export function createLoginPageDsl(): PageDsl {
  const pageId = 'login';
  return createPageDsl({
    id: pageId,
    projectId: 'P1',
    name: '登录页',
    platform: 'web',
    route: '/login',
    featureId: 'F1',
    viewport: { width: 1440, height: 900, presetId: 'web-1440' },
    state: [
      { name: 'phone', type: 'string', initial: '', source: 'local', description: '手机号' },
      { name: 'password', type: 'string', initial: '', source: 'local', description: '密码' },
      {
        name: 'remember',
        type: 'boolean',
        initial: false,
        source: 'local',
        description: '记住登录',
      },
      { name: 'loading', type: 'boolean', initial: false, source: 'local', description: '提交中' },
      { name: 'errorMsg', type: 'string', initial: '', source: 'local', description: '错误提示' },
    ],
    tree: createElement({
      id: 'el-1',
      type: 'Container',
      name: '页面',
      style: { display: 'flex', flexDirection: 'column', minHeight: '100%' },
      children: [
        createElement({
          id: 'el-2',
          type: 'Navbar',
          name: '导航栏',
          children: [
            createElement({
              id: 'el-3',
              type: 'Image',
              name: '站点标识',
              props: { alt: 'EveryoneCoding' },
            }),
            createElement({
              id: 'el-4',
              type: 'Text',
              name: '首页链接',
              props: { text: '首页', href: '/' },
            }),
          ],
        }),
        createElement({
          id: 'el-5',
          type: 'Container',
          name: '登录卡片',
          style: {
            width: 400,
            margin: '80px auto',
            padding: 32,
            borderRadius: 12,
            boxShadow: '0 2px 8px rgba(0,0,0,.08)',
          },
          children: [
            createElement({ id: 'el-6', type: 'Image', name: '品牌标识', props: { alt: 'EC' } }),
            createElement({
              id: 'el-7',
              type: 'Text',
              name: '标题',
              props: { text: '欢迎登录' },
              style: { fontSize: 24, fontWeight: 600, textAlign: 'center' },
            }),
            createElement({
              id: 'el-8',
              type: 'Text',
              name: '副标题',
              props: { text: '使用手机号登录你的账号' },
              style: { textAlign: 'center' },
            }),
            createElement({
              id: 'el-9',
              type: 'Form',
              name: '登录表单',
              featureRef: 'F1',
              style: { display: 'flex', flexDirection: 'column', gap: 16 },
              children: [
                createElement({
                  id: 'el-10',
                  type: 'Input',
                  name: '手机号输入框',
                  featureRef: 'F1',
                  props: { placeholder: '请输入手机号', inputType: 'tel', required: true },
                  bindings: { value: 'phone' },
                }),
                createElement({
                  id: 'el-11',
                  type: 'Input',
                  name: '密码输入框',
                  featureRef: 'F1',
                  props: { placeholder: '请输入密码', inputType: 'password', required: true },
                  bindings: { value: 'password' },
                }),
                createElement({
                  id: 'el-12',
                  type: 'Image',
                  name: '密码可见切换',
                  props: { alt: '显示密码' },
                }),
                createElement({
                  id: 'el-13',
                  type: 'Input',
                  name: '记住登录',
                  featureRef: 'F1',
                  props: { inputType: 'checkbox', placeholder: '记住登录' },
                  bindings: { value: 'remember' },
                }),
                createElement({
                  id: 'el-14',
                  type: 'Text',
                  name: '错误提示',
                  props: { text: '' },
                  style: { color: '#e5484d' },
                  bindings: { text: 'errorMsg' },
                }),
                createElement({
                  id: 'el-15',
                  type: 'Button',
                  name: '登录按钮',
                  featureRef: 'F1',
                  props: { text: '登录', variant: 'primary', block: true },
                  bindings: { disabled: 'loading' },
                }),
              ],
            }),
            createElement({
              id: 'el-16',
              type: 'Container',
              name: '辅助链接组',
              style: { display: 'flex', justifyContent: 'space-between' },
              children: [
                createElement({
                  id: 'el-17',
                  type: 'Text',
                  name: '注册链接',
                  featureRef: 'F2',
                  props: { text: '注册账号', href: '/register' },
                }),
                createElement({
                  id: 'el-18',
                  type: 'Text',
                  name: '忘记密码链接',
                  featureRef: 'F1',
                  props: { text: '忘记密码', href: '/forgot' },
                }),
              ],
            }),
          ],
        }),
        createElement({
          id: 'el-19',
          type: 'Container',
          name: '页脚',
          children: [
            createElement({
              id: 'el-20',
              type: 'Text',
              name: '版权信息',
              props: { text: '© 2026 EveryoneCoding' },
            }),
          ],
        }),
      ],
    }),
    events: [
      {
        id: 'ev-submit',
        trigger: 'click',
        elementId: 'el-15',
        entry: 'act-1',
        actions: [
          {
            id: 'act-1',
            kind: 'assign',
            target: 'loading',
            value: true,
            next: 'act-2',
            label: '置为提交中',
          },
          {
            id: 'act-2',
            kind: 'request',
            target: '/api/auth/login',
            async: true,
            params: {
              body: { phone: '${phone}', password: '${password}', remember: '${remember}' },
            },
            next: 'act-3',
            label: '请求登录接口',
          },
          {
            id: 'act-3',
            kind: 'branch',
            params: { expression: { op: 'eq', left: 'response.code', right: 0 } },
            branchTrue: 'act-4',
            branchFalse: 'act-5',
            label: '是否登录成功',
          },
          { id: 'act-4', kind: 'navigate', target: '/dashboard', label: '跳转仪表盘' },
          {
            id: 'act-5',
            kind: 'notify',
            params: { type: 'error' },
            value: '登录失败，请重试',
            label: '提示失败',
          },
        ],
      },
    ],
    apiDeps: ['/api/auth/login'],
  });
}

/** 移动端 / 鸿蒙端的安全区检查辅助（供画布与一致性校验共用） */
export function needsSafeArea(platform: Platform): boolean {
  return isMobilePlatform(platform);
}
