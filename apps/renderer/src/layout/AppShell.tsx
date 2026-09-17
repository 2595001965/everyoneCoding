import { type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { SplitPane } from '@ec/ui';
import { TitleBar } from './TitleBar';
import { LeftNav } from './LeftNav';
import { RightPanel } from './RightPanel';
import { StatusBar } from './StatusBar';
import { useUiStore } from '../store/useUiStore';

/** 自带右栏（属性/状态/历史）的页面：外壳右侧面板会与之重复，自动隐藏 */
const ROUTES_WITH_OWN_RIGHT_PANEL = ['/designer'];

/**
 * 主布局：顶部标题栏 / 左导航 / 中部主区 / 右侧可折叠面板 / 底部状态栏。
 * 分栏宽度可拖拽调整（SplitPane 支持键盘微调；尺寸单位为像素）。
 * 左导航与右面板固定宽度，中部主区随窗口伸缩。
 */
export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const rightPanelOpen = useUiStore((state) => state.rightPanelOpen);
  const leftNavWidth = useUiStore((state) => state.leftNavWidth);
  const rightPanelWidth = useUiStore((state) => state.rightPanelWidth);
  const setLeftNavWidth = useUiStore((state) => state.setLeftNavWidth);
  const setRightPanelWidth = useUiStore((state) => state.setRightPanelWidth);
  const { pathname } = useLocation();
  const showRightPanel =
    rightPanelOpen && !ROUTES_WITH_OWN_RIGHT_PANEL.some((route) => pathname.startsWith(route));

  const content = <main className="ec-app__content">{children}</main>;

  return (
    <div className="ec-app">
      <TitleBar />
      <div className="ec-app__main">
        <SplitPane
          direction="horizontal"
          initial={leftNavWidth}
          onResize={setLeftNavWidth}
          className="ec-app__navigation-split"
          min={160}
          max={320}
          first={<LeftNav />}
          second={
            showRightPanel ? (
              <SplitPane
                direction="horizontal"
                fixed="second"
                initial={rightPanelWidth}
                onResize={setRightPanelWidth}
                className="ec-app__guide-split"
                min={240}
                max={640}
                first={content}
                second={<RightPanel />}
              />
            ) : (
              content
            )
          }
        />
      </div>
      <StatusBar />
    </div>
  );
}
