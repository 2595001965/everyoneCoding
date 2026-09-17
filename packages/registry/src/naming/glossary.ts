/**
 * 中文术语 → 英文单词表（D-10 的"英文优先"实现）。
 *
 * D-10：组件名与标识符用**英文或拼音**，显示文案保留中文。英文可读性远高于拼音，
 * 因此解析顺序为：项目自定义映射表 → 本表（英文术语） → 内置拼音表 → Unicode 降级。
 *
 * 匹配策略：**长词优先**（贪心最长匹配）。例："用户登录按钮" 在
 * 「用户 / 登录 / 按钮」三词命中，得到 `['user','login','button']`，
 * 而非逐字拼音 `yong-hu-deng-lu-an-niu`。
 *
 * 未收录的中文词仍可正确工作（退化为拼音），本表只影响可读性，不影响正确性。
 */

/** 中文 → 英文单词（小写、单数、语义最小粒度） */
export const ENGLISH_TERMS: Readonly<Record<string, string>> = {
  /* 账户与登录 */
  用户: 'user', 账户: 'account', 账号: 'account', 登录: 'login', 退出: 'logout', 注销: 'logout',
  注册: 'register', 密码: 'password', 邮箱: 'email', 手机: 'phone', 手机号: 'phone',
  验证码: 'code', 验证: 'verify', 令牌: 'token', 会话: 'session', 身份: 'identity',
  找回: 'recover', 重置: 'reset', 第三方: 'oauth', 微信: 'wechat', 昵称: 'nickname',
  头像: 'avatar', 角色: 'role', 权限: 'permission', 授权: 'authorize', 绑定: 'bind',
  解绑: 'unbind', 个人中心: 'profile', 个人信息: 'profile',

  /* 页面与导航 */
  页: 'page', 页面: 'page', 首页: 'home', 欢迎页: 'welcome', 列表页: 'list', 详情页: 'detail',
  导航: 'nav', 导航栏: 'navbar', 侧边栏: 'sidebar', 菜单: 'menu', 面包屑: 'breadcrumb',
  标签页: 'tabs', 页脚: 'footer', 头部: 'header', 底部: 'bottom', 顶部: 'top',
  链接: 'link', 跳转: 'jump', 路由: 'route', 参数: 'param', 返回: 'back',
  上一页: 'prev', 下一页: 'next', 分页: 'pagination', 步骤: 'step', 进度: 'progress',

  /* 布局与容器 */
  容器: 'container', 布局: 'layout', 行: 'row', 列: 'column', 网格: 'grid', 卡片: 'card',
  面板: 'panel', 抽屉: 'drawer', 弹窗: 'modal', 对话框: 'dialog', 分栏: 'split',
  区域: 'area', 区块: 'block', 边距: 'margin', 内边距: 'padding', 间距: 'gap',
  宽度: 'width', 高度: 'height', 居中: 'center', 居左: 'alignLeft', 居右: 'alignRight',
  固定: 'fixed', 流式: 'flow', 自适应: 'adaptive', 滚动: 'scroll',

  /* 基础控件 */
  文本: 'text', 标题: 'title', 按钮: 'button', 输入框: 'input', 输入: 'input',
  下拉框: 'select', 选择器: 'picker', 下拉: 'dropdown', 复选框: 'checkbox',
  单选框: 'radio', 开关: 'switch', 滑块: 'slider', 表单: 'form', 表单项: 'field',
  文本域: 'textarea', 日期选择器: 'datePicker', 上传: 'upload', 下载: 'download',
  图片: 'image', 图标: 'icon', 视频: 'video', 音视频: 'media', 富文本: 'richText',

  /* 数据展示 */
  表格: 'table', 图表: 'chart', 柱状图: 'barChart', 折线图: 'lineChart', 饼图: 'pieChart',
  趋势: 'trend', 仪表盘: 'dashboard', 看板: 'board', 徽章: 'badge', 标签: 'tag',
  排序: 'sort', 筛选: 'filter', 搜索: 'search', 查询: 'query', 统计: 'statistics', 总计: 'total',

  /* 业务名词 */
  商品: 'product', 产品: 'product', 订单: 'order', 购物车: 'cart', 支付: 'payment',
  价格: 'price', 金额: 'amount', 数量: 'count', 库存: 'stock', 销售: 'sales',
  库存量: 'stock', 分类: 'category', 类目: 'category', 品牌: 'brand', 评论: 'comment',
  评分: 'rating', 收藏: 'favorite', 消息: 'message', 通知: 'notice', 任务: 'task',
  项目: 'project', 功能: 'feature', 模块: 'module', 需求: 'requirement', 文档: 'document',
  备注: 'note', 状态: 'status', 类型: 'type', 名称: 'name', 描述: 'description',
  详情: 'detail', 内容: 'content', 创建: 'create', 编辑: 'edit', 删除: 'remove',
  更新: 'update', 保存: 'save', 提交: 'submit', 取消: 'cancel', 确认: 'confirm',
  关闭: 'close', 开启: 'enable', 禁用: 'disable', 重置按钮: 'resetButton',

  /* 反馈态 */
  成功: 'success', 失败: 'failure', 错误: 'error', 警告: 'warning', 提示: 'tip',
  加载: 'loading', 空: 'empty', 无数据: 'emptyState', 重试: 'retry', 刷新: 'refresh',
  时间: 'time', 日期: 'date', 时长: 'duration',

  /* 逻辑结构 */
  动作: 'action', 事件: 'event', 请求: 'request', 响应: 'response', 数据: 'data',
  数据源: 'dataSource', 接口: 'api', 字段: 'field', 校验: 'validate', 条件: 'condition',
  循环: 'loop', 变量: 'variable', 状态机: 'stateMachine',

  /* 项目 / 开发对象（供 element / page / feature 之外的引用） */
  组件: 'component', 视图: 'view', 文件: 'file', 目录: 'directory', 服务: 'service',
  控制器: 'controller', 仓储: 'repository', 数据库: 'database', 迁移: 'migration',
};

/** 词表规模（测试与文档断言用） */
export function englishTermCount(): number {
  return Object.keys(ENGLISH_TERMS).length;
}
