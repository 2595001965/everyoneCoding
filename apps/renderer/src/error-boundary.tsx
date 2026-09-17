import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@ec/ui';

/**
 * 渲染异常边界：捕获子树错误并展示详情 + 复制日志（FR 可用性 / 崩溃可观测）。
 */

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? '' });
    // 日志统一脱敏由 @ec/core logger 负责；此处仅控制台兜底
    console.error('[ErrorBoundary]', error.message);
  }

  private readonly copyLog = (): void => {
    const { error, info } = this.state;
    const text = `${error?.name ?? 'Error'}: ${error?.message ?? ''}\n${info}`;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div role="alert" className="ec-error-boundary">
        <h1>页面出错了</h1>
        <pre className="ec-error-boundary__detail">{`${error.name}: ${error.message}`}</pre>
        <Button variant="primary" onClick={this.copyLog}>
          复制日志
        </Button>
        <Button onClick={() => window.location.reload()}>重新加载</Button>
      </div>
    );
  }
}
