import { AppIcon, type AppIconName } from '../../layout/AppIcon';

const starters: Array<{
  icon: AppIconName;
  title: string;
  description: string;
  href: string;
  action: string;
}> = [
  {
    icon: 'designer',
    title: '先从界面开始',
    description: '打开示例画布，拖拽组件，探索页面布局与交互。',
    href: '#/designer',
    action: '体验设计器',
  },
  {
    icon: 'settings',
    title: '连接你的 AI',
    description: '配置模型服务，为需求分析与代码生成做好准备。',
    href: '#/settings',
    action: '打开设置',
  },
  {
    icon: 'pipeline',
    title: '了解开发流程',
    description: '从需求到交付，按阶段组织产物、修改与确认。',
    href: '#/pipeline',
    action: '查看流水线',
  },
];

export function WorkspaceWelcome(): JSX.Element {
  return (
    <section className="ec-welcome" aria-label="工作台">
      <header className="ec-welcome__heading">
        <div>
          <span className="ec-eyebrow">YOUR CREATIVE WORKSPACE</span>
          <h1>工作台</h1>
          <p>把灵感带到这里，让下一个作品从这里开始。</p>
        </div>
        <span className="ec-welcome__badge">
          <span />
          本地工作空间
        </span>
      </header>
      <div className="ec-welcome__hero">
        <div className="ec-welcome__copy">
          <span className="ec-welcome__kicker">从想法，到作品</span>
          <h2>
            专注创造，
            <br />让 AI 帮你实现。
          </h2>
          <p>
            设计界面，沉淀项目记忆，逐步生成代码。
            <br />
            每个阶段清晰可见，每次迭代都有迹可循。
          </p>
          <a className="ec-welcome__primary" href="#/designer">
            探索设计器
            <AppIcon name="arrow" size={17} />
          </a>
          <span className="ec-welcome__caption">从内置示例开始，熟悉你的创作工具</span>
        </div>
        <div className="ec-welcome__illustration" aria-hidden="true">
          <div className="ec-welcome__canvas">
            <div className="ec-welcome__canvas-bar">
              <i />
              <i />
              <i />
              <span>your-next-idea</span>
            </div>
            <div className="ec-welcome__canvas-body">
              <div className="ec-welcome__mini-nav">
                <b />
                <b />
                <b />
                <b />
              </div>
              <div className="ec-welcome__mini-page">
                <span className="ec-welcome__mini-tag">HELLO, WORLD</span>
                <strong>
                  Make something
                  <br />
                  that matters.
                </strong>
                <div className="ec-welcome__mini-lines">
                  <i />
                  <i />
                </div>
                <div className="ec-welcome__mini-cards">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
          </div>
          <div className="ec-welcome__float">
            <AppIcon name="check" size={16} />
            <span>灵感，正在成为现实</span>
          </div>
        </div>
      </div>
      <div className="ec-welcome__section-head">
        <h2>选择你的起点</h2>
        <span>一个工作空间，连接整个创作过程</span>
      </div>
      <div className="ec-welcome__starters">
        {starters.map((item, index) => (
          <a className="ec-welcome__starter" href={item.href} key={item.href}>
            <div className="ec-welcome__starter-top">
              <span className="ec-welcome__starter-icon">
                <AppIcon name={item.icon} size={22} />
              </span>
              <span className="ec-welcome__number">0{index + 1}</span>
            </div>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
            <span className="ec-welcome__starter-action">
              {item.action}
              <AppIcon name="arrow" size={16} />
            </span>
          </a>
        ))}
      </div>
      <div className="ec-welcome__connection" role="status">
        <span className="ec-welcome__connection-icon">
          <AppIcon name="workspace" size={20} />
        </span>
        <div>
          <strong>准备好你的本地项目空间</strong>
          <p>
            工作台尚未连接本地数据库。请在桌面端完成初始化后创建或导入项目；现在可以先体验示例设计器。
          </p>
        </div>
      </div>
      <footer className="ec-welcome__footer">
        <span>你的项目，你的节奏。</span>
        <span>
          快速切换功能 <kbd>Ctrl K</kbd>
        </span>
      </footer>
    </section>
  );
}
