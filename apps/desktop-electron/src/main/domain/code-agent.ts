import {
  OUTPUT_CONTRACT_TEXT,
  createGenerator,
  type AgentExecution,
  type TaskRecord,
  type GenerationResult,
  type GenerationTarget,
  type StreamChunk,
  type WritePlan,
  type GenerationOutput,
} from '@ec/ai';
import { ShellError } from '@ec/shell-api';
import type { AiStackHandle } from './domain-factories';
import type { CodeGenerateResult } from './domains/code-domain';
import { errorOfStreamChunk, textOfStreamChunk } from './ai-stream-text';

export function isGenerationCheckpoint(value: unknown): value is GenerationResult {
  if (value === null || typeof value !== 'object') return false;
  const checkpoint = value as Partial<GenerationResult>;
  return (
    typeof checkpoint.raw === 'string' &&
    typeof checkpoint.partial === 'boolean' &&
    typeof checkpoint.attempts === 'number' &&
    checkpoint.parse !== undefined &&
    'output' in checkpoint
  );
}

export async function executeCodeTask(
  record: TaskRecord,
  execution: AgentExecution,
  options: {
    aiStack: AiStackHandle | null;
    userId: string;
    plan(projectId: string, output: GenerationOutput, noteIds?: string[]): Promise<WritePlan>;
  },
): Promise<{
  result: CodeGenerateResult;
  status: 'awaiting_confirmation' | 'cancelled' | 'failed';
}> {
  const aiStack = options.aiStack;
  if (aiStack === null) throw new ShellError('NOT_SUPPORTED', 'AI 栈未装配，请先配置模型服务');
  const request = record.request;
  const projectId = record.task.projectId;
  const target = String(request['target'] ?? 'backend-code') as GenerationTarget;
  const resume = isGenerationCheckpoint(request['resume'])
    ? request['resume']
    : isGenerationCheckpoint(record.checkpoint)
      ? record.checkpoint
      : undefined;
  const rework = request['kind'] === 'rework';
  const system = rework
    ? `${OUTPUT_CONTRACT_TEXT}\n\n按用户要求重改已有代码。`
    : String(request['system'] ?? '');
  const user = rework
    ? `${String(request['instruction'])}\n当前差异：\n${String(request['context'] ?? '')}`
    : String(request['user'] ?? '');
  let answeredBy: string | null = null;
  let streamError: string | null = null;
  let checkpointText = resume?.raw ?? '';
  let modelRun = 0;
  const generator = createGenerator({
    run: (run) =>
      (async function* () {
        execution.assertOwner();
        const logicalRequestId = `${record.task.taskId}:${record.task.revision}:${modelRun++}`;
        for await (const chunk of aiStack.gateway.chat({
          userId: options.userId,
          purpose: 'code',
          projectId,
          sessionId: record.task.sessionId ?? undefined,
          taskId: record.task.taskId,
          logicalRequestId,
          messages: run.messages as ReadonlyArray<{ role: string; content: string }>,
          signal: execution.signal,
          ...(typeof request['modelId'] === 'string' ? { modelId: request['modelId'] } : {}),
          ...(typeof request['providerId'] === 'string'
            ? { providerId: request['providerId'] }
            : {}),
          ...(run.temperature !== undefined ? { temperature: run.temperature } : {}),
          ...(run.maxTokens !== undefined ? { maxTokens: run.maxTokens } : {}),
        })) {
          execution.assertOwner();
          const delta = textOfStreamChunk(chunk);
          if (delta.model !== null) answeredBy = delta.model;
          const error = errorOfStreamChunk(chunk);
          if (error !== null) streamError = error;
          yield chunk as unknown as StreamChunk;
        }
      })(),
  });
  execution.event('agent.output.started', {
    type: 'code:generate-started',
    projectId,
    target,
    resumed: resume !== undefined,
  });
  const shared = {
    signal: execution.signal,
    ...(typeof request['temperature'] === 'number' ? { temperature: request['temperature'] } : {}),
    ...(typeof request['maxTokens'] === 'number' ? { maxTokens: request['maxTokens'] } : {}),
    onDelta: (text: string) => {
      checkpointText += text;
      execution.checkpoint({ raw: checkpointText });
      execution.event('agent.output.delta', { type: 'code:generate-delta', projectId, text });
    },
  };
  const result = resume
    ? await generator.continueGeneration(resume, shared)
    : await generator.generate({ ...shared, target, prompt: { system, user } });
  execution.checkpoint(result);
  execution.assertOwner();
  // 上游在流内报错（未配置模型 / 预算超限 / 服务不可用）：如实拒绝并保留可执行指引，
  // 不能吞成"空 aborted"让调用方误以为模型返回了空内容。
  if (!execution.signal.aborted && streamError !== null && result.output === null) {
    execution.event('agent.output.done', {
      type: 'code:generate-done',
      projectId,
      status: 'failed',
    });
    throw new ShellError('NOT_SUPPORTED', streamError);
  }
  const base = {
    raw: result.raw,
    partial: result.partial,
    attempts: result.attempts,
    model: answeredBy,
    summary: result.output?.summary ?? null,
    issues: result.parse.issues,
    taskId: record.task.taskId,
    sessionId: record.task.sessionId ?? '',
  };
  if (execution.signal.aborted || (result.partial && result.output === null)) {
    execution.event('agent.output.done', {
      type: 'code:generate-done',
      projectId,
      status: 'aborted',
    });
    return { result: { ...base, status: 'aborted', plan: null }, status: 'cancelled' };
  }
  if (result.output === null) {
    if (streamError !== null) base.issues = [...base.issues, streamError];
    execution.event('agent.output.done', {
      type: 'code:generate-done',
      projectId,
      status: 'degraded',
    });
    return { result: { ...base, status: 'degraded', plan: null }, status: 'failed' };
  }
  if (result.output.files.length > 40)
    throw new ShellError('INVALID_ARGUMENT', '单次生成文件数超限，请拆分后重试');
  const noteIds = Array.isArray(request['noteIds'])
    ? request['noteIds'].filter((id): id is string => typeof id === 'string')
    : undefined;
  const plan = await options.plan(projectId, result.output, noteIds);
  execution.assertOwner();
  execution.event('agent.output.plan', {
    type: 'code:write-plan',
    projectId,
    plan,
    source: rework ? 'rework' : 'generate',
  });
  execution.event('agent.output.done', {
    type: 'code:generate-done',
    projectId,
    status: 'planned',
  });
  return { result: { ...base, status: 'planned', plan }, status: 'awaiting_confirmation' };
}
