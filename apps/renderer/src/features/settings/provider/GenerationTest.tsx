import { useRef, useState } from 'react';

import { Button, Textarea } from '@ec/ui';
import type { AiStreamEvent, AiStreamHandle } from '@ec/shell-api';

import { useAiSettings } from '../ai-settings-context';

/**
 * 一次真实生成（E2E-10 的最后一环）。
 *
 * 走 ShellHost.ai.stream：delta 逐块追加，可随时中断；
 * 失败的展示沿用 AI 错误里的 userMessage / action，不抛异常到整页。
 */
export function GenerationTest(): JSX.Element {
  const api = useAiSettings();
  const [prompt, setPrompt] = useState('用一句话介绍你自己。');
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'running' | 'ok' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<AiStreamHandle | null>(null);

  const start = (): void => {
    setText('');
    setError(null);
    setState('running');
    const handle = api.streamChat({
      purpose: 'code',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 64,
    });
    handleRef.current = handle;
    let failed = false;
    handle.on((event: AiStreamEvent) => {
      if (event.type === 'chunk' && event.payload['type'] === 'delta') {
        setText((current) => current + String(event.payload['text'] ?? ''));
        return;
      }
      if (event.type === 'error') {
        failed = true;
        setError(event.error.message);
        setState('failed');
        return;
      }
      if (event.type === 'done') {
        if (event.partial && !failed) setError('生成未完成（已保留已产出内容）');
        setState(event.partial ? 'failed' : 'ok');
      }
    });
  };

  const stop = (): void => {
    handleRef.current?.abort();
    setState('idle');
  };

  return (
    <section className="ec-ai__section" aria-label="生成测试">
      <h2 className="ec-ai__section-title">生成测试</h2>
      <p className="ec-ai__hint">用当前默认模型发一次真实请求，验证「连通之后确实能生成」。</p>

      <label className="ec-ai__field ec-ai__field--wide">
        <span>提示词</span>
        <Textarea value={prompt} onChange={setPrompt} placeholder="写点什么让模型回答" />
      </label>

      <span className="ec-ai__row-actions">
        <Button variant="secondary" size="sm" onClick={start} disabled={state === 'running'}>
          开始生成
        </Button>
        <Button variant="ghost" size="sm" onClick={stop} disabled={state !== 'running'}>
          中断
        </Button>
      </span>

      {error ? <p className="ec-ai__error">{error}</p> : null}
      {text ? (
        <pre className="ec-ai__preview" aria-live="polite">
          {text}
        </pre>
      ) : null}
    </section>
  );
}
