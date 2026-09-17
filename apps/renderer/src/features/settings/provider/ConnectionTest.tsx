import { useState } from 'react';

import { Button, Tag } from '@ec/ui';

import type { ConnectionTestResult } from '@ec/ai';

/**
 * 连接测试：展示模型列表来源、延迟与失败原因。
 * 测试语义（列模型 + 一次最小对话）由 @ec/ai 的 runConnectionTest 保证。
 */

export type TestState = 'idle' | 'running' | 'ok' | 'failed';

export interface ConnectionTestProps {
  state: TestState;
  result: ConnectionTestResult | null;
  error?: string | null;
  onTest(): void;
  disabled?: boolean;
}

const STATE_TEXT: Record<TestState, string> = {
  idle: '未测试',
  running: '测试中…',
  ok: '连接成功',
  failed: '连接失败',
};

export function ConnectionTest({ state, result, error = null, onTest, disabled = false }: ConnectionTestProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const models = result?.models.models ?? [];

  return (
    <div className="ec-ai__test" aria-live="polite">
      <div className="ec-ai__test-row">
        <Button variant="secondary" size="sm" onClick={onTest} disabled={disabled || state === 'running'} loading={state === 'running'}>
          连接测试
        </Button>
        <Tag color={state === 'ok' ? 'success' : state === 'failed' ? 'danger' : 'neutral'}>{STATE_TEXT[state]}</Tag>
        {result ? <span className="ec-ai__hint">耗时 {result.latencyMs} ms</span> : null}
      </div>

      {error ? <p className="ec-ai__error">{error}</p> : null}

      {result && !result.ok && result.error ? (
        <div className="ec-ai__error-box">
          <strong>{result.error.userMessage}</strong>
          <p>{result.error.action}</p>
        </div>
      ) : null}

      {models.length > 0 ? (
        <div className="ec-ai__test-models">
          <div className="ec-ai__test-head">
            <span>
              可用模型 {models.length} 个
              {result?.models.source === 'manual' ? '（来自手动填写）' : '（来自 /models）'}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '展开'}
            </Button>
          </div>
          {expanded ? (
            <ul className="ec-ai__chips">
              {models.map((model) => (
                <li key={model.id}>
                  <Tag color="neutral">{model.name}</Tag>
                </li>
              ))}
            </ul>
          ) : null}
          {result?.models.note ? <p className="ec-ai__hint">{result.models.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
