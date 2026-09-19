import type { ReactElement } from 'react';
import { useState } from 'react';
import type { TechChoice, TechDocGenerationResult } from '@ec/pipeline';
import { techChoiceToStack } from '@ec/pipeline';
import { usePipelineOptional } from './pipeline-api';
import { ArtifactViewer } from './ArtifactViewer';
import { Button, EmptyState, Spinner, Tag, Textarea } from '@ec/ui';

export interface TechDocPanelProps {
  projectId: string;
  userId: string;
  projectName: string;
  requirementDoc: string;
  choice: TechChoice;
}

/** 技术文档面板（T5-04）：展示技术栈摘要，调用生成接口并展示校验结果 */
export function TechDocPanel({
  projectId,
  userId,
  projectName,
  requirementDoc,
  choice,
}: TechDocPanelProps): ReactElement {
  const api = usePipelineOptional();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TechDocGenerationResult | null>(null);
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async (): Promise<void> => {
    if (api === null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.generateTechDoc({
        projectId,
        userId,
        projectName,
        // 面板未接收项目描述，暂以空串兜底（接口要求 description 字段）
        description: '',
        choice,
        requirementDoc,
        ...(instruction.trim().length > 0 ? { instruction: instruction.trim() } : {}),
      });
      setResult(res);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  if (api === null) {
    return (
      <EmptyState title="流水线未初始化" description="请先注入 PipelineApi 后再生成技术文档。" />
    );
  }

  return (
    <div className="ec-pipe-techdoc" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>技术栈摘要</div>
        <pre
          style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            padding: 10,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            margin: 0,
          }}
        >
          {techChoiceToStack(choice)}
        </pre>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13, color: '#475569' }}>补充要求（可选）</span>
        <Textarea
          value={instruction}
          onChange={setInstruction}
          placeholder="例如：需要包含鉴权方案与 WebSocket 实时通信"
          rows={2}
        />
        <div>
          <Button variant="primary" onClick={handleGenerate} disabled={loading}>
            {loading ? '生成中…' : '生成技术文档'}
          </Button>
        </div>
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6b7280' }}>
          <Spinner /> 正在生成技术文档…
        </div>
      )}

      {error !== null && (
        <div
          style={{ color: '#dc2626', background: '#fef2f2', borderRadius: 6, padding: '8px 10px' }}
        >
          {error}
        </div>
      )}

      {result !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Tag color="info">v{result.version}</Tag>
            <Tag color="neutral">{result.title}</Tag>
            {result.regenerated && <Tag color="warning">已触发重生成</Tag>}
            {result.degraded && <Tag color="warning">降级输出</Tag>}
          </div>

          <ArtifactViewer content={result.content} artifactType="tech_doc" />

          {result.completeness.missing.length > 0 && (
            <div style={{ background: '#fffbeb', borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ fontWeight: 600, color: '#b45309' }}>文档缺失章节：</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: '#92400e' }}>
                {result.completeness.missing.map((section) => (
                  <li key={section}>{section}</li>
                ))}
              </ul>
            </div>
          )}

          {result.openApi !== null && (
            <div
              style={{
                background: result.openApi.valid ? '#f0fdf4' : '#fef2f2',
                borderRadius: 6,
                padding: '8px 10px',
                color: result.openApi.valid ? '#166534' : '#dc2626',
              }}
            >
              <div style={{ fontWeight: 600 }}>
                OpenAPI 草案校验：{result.openApi.valid ? '通过' : '未通过'}
              </div>
              {!result.openApi.valid && result.openApi.issues.length > 0 && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {result.openApi.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {result.forbiddenHit.length > 0 && (
            <div
              style={{
                background: '#fef2f2',
                borderRadius: 6,
                padding: '8px 10px',
                color: '#dc2626',
              }}
            >
              <div style={{ fontWeight: 600 }}>命中禁止技术：</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {result.forbiddenHit.map((tech) => (
                  <li key={tech}>{tech}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
