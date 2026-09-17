/**
 * 项目模板（T9-01 / FR-WSP-02）。
 *
 * 三套内置模板：Web 管理后台 / 移动端 App / 官网落地页。
 * 每套模板 = 初始页面骨架（元素树，类型取设计器 15 类组件库）+ 项目记忆草稿 + 推荐目标端与方案。
 *
 * 为什么这里用"结构化镜像"而不是直接引 `@ec/designer` 的 `PageDsl`：
 * designer 依赖 core（反向依赖会循环），故模板以自描述结构表达，
 * 由外壳装配时（Wave 9/10）经设计器 DSL 入口落库；字段名与 PageDsl 的
 * `PageElement`（type/name/props/style/children）保持一致。
 */

import type { TargetPlatform } from './project-types';

/** 模板元素（与设计器 PageElement 结构对齐的镜像类型） */
export interface TemplateElement {
  type: string;
  name: string;
  props: Record<string, unknown>;
  style?: Record<string, unknown> | undefined;
  children?: TemplateElement[] | undefined;
}

/** 模板页面 */
export interface TemplatePage {
  name: string;
  route: string;
  /** 该页面主用端（决定设计器画布默认预设） */
  platform: TargetPlatform;
  /** 页面级备注（随页面记忆一起落库） */
  note: string;
  elements: TemplateElement[];
}

/** 项目记忆草稿条目 */
export interface TemplateMemoryDraft {
  scope: 'project' | 'feature';
  title: string;
  content: string;
  tags: string[];
}

/** 模板定义 */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  /** 推荐目标端 */
  targetPlatforms: TargetPlatform[];
  /** 各端技术方案（FR-AI-13 矩阵的 value，如 web → react） */
  techStack: Record<string, string>;
  pages: TemplatePage[];
  memoryDrafts: TemplateMemoryDraft[];
}

/** 设计器内置组件类型白名单（15 类，供模板夹具一致性校验） */
export const TEMPLATE_COMPONENT_TYPES = [
  'Container',
  'Navbar',
  'Sidebar',
  'Image',
  'Text',
  'Form',
  'Input',
  'Button',
  'Table',
  'List',
  'Card',
  'Tabs',
  'Modal',
  'Chart',
  'Footer',
] as const;

function input(name: string, label: string, inputType = 'text'): TemplateElement {
  return {
    type: 'Input',
    name,
    props: { label, placeholder: label, inputType },
    style: { width: '100%' },
  };
}

function button(name: string, text: string, variant = 'primary'): TemplateElement {
  return { type: 'Button', name, props: { text, variant }, style: { width: '100%' } };
}

function text(name: string, content: string, fontSize = 16): TemplateElement {
  return { type: 'Text', name, props: { content, fontSize } };
}

/** 模板一：Web 管理后台 */
const adminConsole: ProjectTemplate = {
  id: 'tpl-web-admin',
  name: 'Web 管理后台',
  description: '登录 + 数据看板 + 列表管理三页，含侧边导航与表格，适合内部系统。',
  targetPlatforms: ['web'],
  techStack: { web: 'react' },
  pages: [
    {
      name: '登录页',
      route: '/login',
      platform: 'web',
      note: '登录需前端基础校验：账号必填、密码不少于 8 位。',
      elements: [
        {
          type: 'Container',
          name: 'loginPage',
          props: { layout: 'center' },
          style: { minHeight: '100vh' },
          children: [
            text('appTitle', '管理后台', 24),
            {
              type: 'Form',
              name: 'loginForm',
              props: { submitMode: 'ajax' },
              children: [
                input('account', '账号'),
                input('password', '密码', 'password'),
                button('submitBtn', '登录'),
              ],
            },
          ],
        },
      ],
    },
    {
      name: '数据看板',
      route: '/dashboard',
      platform: 'web',
      note: '看板展示核心指标卡片与趋势图，数据来自 /api/stats 接口。',
      elements: [
        {
          type: 'Container',
          name: 'dashboardPage',
          props: { layout: 'vertical' },
          children: [
            { type: 'Sidebar', name: 'mainNav', props: { items: ['看板', '用户管理', '系统设置'] } },
            {
              type: 'Container',
              name: 'metrics',
              props: { layout: 'horizontal' },
              children: [
                { type: 'Card', name: 'cardUsers', props: { title: '用户数', value: '--' } },
                { type: 'Card', name: 'cardOrders', props: { title: '订单数', value: '--' } },
                { type: 'Card', name: 'cardRevenue', props: { title: '营收', value: '--' } },
              ],
            },
            { type: 'Chart', name: 'trendChart', props: { chartType: 'line', dataSource: '/api/stats/trend' } },
          ],
        },
      ],
    },
    {
      name: '用户管理',
      route: '/users',
      platform: 'web',
      note: '用户列表支持分页、关键字搜索与行内编辑删除，删除需二次确认。',
      elements: [
        {
          type: 'Container',
          name: 'usersPage',
          props: { layout: 'vertical' },
          children: [
            { type: 'Navbar', name: 'topBar', props: { title: '用户管理' } },
            {
              type: 'Form',
              name: 'searchForm',
              props: { submitMode: 'ajax' },
              children: [input('keyword', '关键字'), button('searchBtn', '搜索', 'default')],
            },
            {
              type: 'Table',
              name: 'userTable',
              props: {
                columns: [
                  { key: 'name', title: '姓名' },
                  { key: 'email', title: '邮箱' },
                  { key: 'role', title: '角色' },
                ],
                dataSource: '/api/users',
              },
            },
          ],
        },
      ],
    },
  ],
  memoryDrafts: [
    {
      scope: 'project',
      title: '后台管理系统的统一约束',
      content: '所有列表页统一分页参数 page/size；所有删除操作必须二次确认；接口统一返回 {code,data,message}。',
      tags: ['规范', '后台'],
    },
    {
      scope: 'project',
      title: '技术栈',
      content: '前端 React + TypeScript，后端 REST 接口，数据库关系型，具体方案在技术选型阶段确认。',
      tags: ['技术栈'],
    },
  ],
};

/** 模板二：移动端 App */
const mobileApp: ProjectTemplate = {
  id: 'tpl-mobile-app',
  name: '移动端 App',
  description: '移动端首页 + 列表 + 详情 + 个人中心，Flutter 单代码库覆盖 Android / iOS。',
  targetPlatforms: ['android', 'ios'],
  techStack: { android: 'flutter', ios: 'flutter' },
  pages: [
    {
      name: '首页',
      route: '/',
      platform: 'android',
      note: '首页顶部为搜索入口，中部为推荐卡片流，底部固定四标签导航。',
      elements: [
        {
          type: 'Container',
          name: 'homePage',
          props: { layout: 'vertical' },
          children: [
            {
              type: 'Form',
              name: 'searchForm',
              props: { submitMode: 'ajax' },
              children: [input('keyword', '搜索')],
            },
            {
              type: 'List',
              name: 'feedList',
              props: { dataSource: '/api/feed', itemTemplate: 'card', pagination: 'infinite' },
            },
            { type: 'Footer', name: 'tabBar', props: { tabs: ['首页', '分类', '消息', '我的'] } },
          ],
        },
      ],
    },
    {
      name: '详情页',
      route: '/detail/:id',
      platform: 'android',
      note: '详情页需支持分享与收藏，图片懒加载。',
      elements: [
        {
          type: 'Container',
          name: 'detailPage',
          props: { layout: 'vertical' },
          children: [
            { type: 'Navbar', name: 'detailNav', props: { title: '详情', showBack: true } },
            { type: 'Image', name: 'coverImage', props: { src: '', lazy: true } },
            text('detailTitle', '标题占位', 20),
            text('detailBody', '正文占位', 14),
            button('collectBtn', '收藏', 'default'),
          ],
        },
      ],
    },
    {
      name: '个人中心',
      route: '/profile',
      platform: 'ios',
      note: '个人中心展示头像昵称与设置项，未登录时跳转登录。',
      elements: [
        {
          type: 'Container',
          name: 'profilePage',
          props: { layout: 'vertical' },
          children: [
            { type: 'Image', name: 'avatar', props: { src: '', shape: 'circle' } },
            text('nickname', '未登录', 18),
            { type: 'List', name: 'settingList', props: { dataSource: 'local', items: ['我的收藏', '设置', '关于'] } },
          ],
        },
      ],
    },
  ],
  memoryDrafts: [
    {
      scope: 'project',
      title: '移动端交互约定',
      content: '列表统一下拉刷新 + 触底加载；详情页返回保留列表滚动位置；所有网络请求带统一错误提示。',
      tags: ['移动端', '交互'],
    },
    {
      scope: 'project',
      title: '技术栈',
      content: 'Android 与 iOS 采用 Flutter 单代码库，状态管理由技术选型阶段确认。',
      tags: ['技术栈'],
    },
  ],
};

/** 模板三：官网落地页 */
const landingSite: ProjectTemplate = {
  id: 'tpl-landing',
  name: '官网落地页',
  description: '单页营销站点：首屏 Banner + 特性介绍 + 表单留资 + 页脚。',
  targetPlatforms: ['web'],
  techStack: { web: 'react' },
  pages: [
    {
      name: '首页',
      route: '/',
      platform: 'web',
      note: '落地页首屏需 1 秒内可见主标题与行动按钮；留资表单提交后展示成功提示。',
      elements: [
        {
          type: 'Container',
          name: 'landingPage',
          props: { layout: 'vertical' },
          children: [
            { type: 'Navbar', name: 'nav', props: { title: '产品名', links: ['特性', '价格', '联系我们'] } },
            { type: 'Image', name: 'heroBanner', props: { src: '', alt: '首屏主视觉' } },
            text('heroTitle', '一句话说清产品价值', 32),
            text('heroSubtitle', '补充一句话说明适用场景', 16),
            button('ctaBtn', '免费试用'),
            {
              type: 'Container',
              name: 'features',
              props: { layout: 'horizontal' },
              children: [
                { type: 'Card', name: 'feature1', props: { title: '特性一', value: '说明文字' } },
                { type: 'Card', name: 'feature2', props: { title: '特性二', value: '说明文字' } },
                { type: 'Card', name: 'feature3', props: { title: '特性三', value: '说明文字' } },
              ],
            },
            {
              type: 'Form',
              name: 'leadForm',
              props: { submitMode: 'ajax' },
              children: [input('name', '姓名'), input('phone', '手机号'), button('submitLead', '提交')],
            },
            { type: 'Footer', name: 'siteFooter', props: { copyright: '© 示例公司' } },
          ],
        },
      ],
    },
  ],
  memoryDrafts: [
    {
      scope: 'project',
      title: '落地页转化约定',
      content: '主行动按钮在首屏可见；留资表单仅收集必要字段（姓名 + 手机号）；不引入第三方统计脚本。',
      tags: ['营销', '转化'],
    },
  ],
};

/** 全部内置模板（顺序即 UI 展示顺序） */
export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [adminConsole, mobileApp, landingSite];

export function findTemplate(id: string): ProjectTemplate | null {
  return PROJECT_TEMPLATES.find((template) => template.id === id) ?? null;
}

/**
 * 模板一致性自检：元素类型必须在设计器 15 类组件库内、路由以 / 开头、
 * 至少一个页面、至少一条项目记忆草稿。外壳装配前调用，避免"模板拖不进设计器"。
 */
export function validateTemplate(template: ProjectTemplate): string[] {
  const issues: string[] = [];
  if (template.pages.length === 0) issues.push(`${template.name}：至少需要一个页面`);
  if (template.memoryDrafts.length === 0) issues.push(`${template.name}：至少需要一条项目记忆草稿`);

  const allowed = new Set<string>(TEMPLATE_COMPONENT_TYPES);
  const walk = (elements: readonly TemplateElement[], path: string): void => {
    for (const element of elements) {
      if (!allowed.has(element.type)) {
        issues.push(`${template.name}：${path} 使用未注册组件类型 ${element.type}`);
      }
      if (element.children && element.children.length > 0) walk(element.children, `${path}/${element.name}`);
    }
  };

  for (const page of template.pages) {
    if (!page.route.startsWith('/')) issues.push(`${template.name}：页面 ${page.name} 路由必须以 / 开头`);
    if (!template.targetPlatforms.includes(page.platform)) {
      issues.push(`${template.name}：页面 ${page.name} 的 platform ${page.platform} 不在模板目标端内`);
    }
    walk(page.elements, page.name);
  }
  return issues;
}

/** 模板元素总数（用于 UI 提示"将创建 N 个元素"） */
export function countTemplateElements(template: ProjectTemplate): number {
  const count = (elements: readonly TemplateElement[]): number =>
    elements.reduce((sum, element) => sum + 1 + (element.children ? count(element.children) : 0), 0);
  return template.pages.reduce((sum, page) => sum + count(page.elements), 0);
}
