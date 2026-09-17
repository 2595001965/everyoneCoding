import { Link } from 'react-router-dom';
import { AppIcon } from './AppIcon';

/** Optional guide with usable destinations instead of an empty property panel. */
export function RightPanel(): JSX.Element {
  return (
    <aside aria-label="工作指南" className="ec-rightpanel">
      <span className="ec-eyebrow">WORKSPACE GUIDE</span>
      <h2 className="ec-rightpanel__title">让想法逐步成形</h2>
      <p>从需求开始，保留每一步产物，让设计、记忆与代码相互连接。</p>
      <ol className="ec-rightpanel__steps">
        <li>
          <strong>描述需求</strong>
          <span>在流水线中梳理功能与验收标准。</span>
        </li>
        <li>
          <strong>设计界面</strong>
          <span>拖拽组件，调整布局与页面状态。</span>
        </li>
        <li>
          <strong>生成与验证</strong>
          <span>逐个生成功能，在预览中验证效果。</span>
        </li>
      </ol>
      <Link to="/pipeline">
        <AppIcon name="pipeline" />
        前往流水线
        <AppIcon name="arrow" size={15} />
      </Link>
      <Link to="/memory">
        <AppIcon name="memory" />
        管理项目记忆
        <AppIcon name="arrow" size={15} />
      </Link>
      <p className="ec-rightpanel__tip">
        使用 <kbd>Ctrl K</kbd> 随时跳转到其他功能。
      </p>
    </aside>
  );
}
