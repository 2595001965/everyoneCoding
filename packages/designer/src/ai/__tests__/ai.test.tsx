import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createLoginPageDsl } from '../../dsl/factory';
import { findById, walkElements } from '../../dsl/traverse';
import { registerBuiltinComponents } from '../../components';
import { ComponentRegistry } from '../../registry/component-registry';
import { DesignerProvider } from '../../store/designer-context';
import type { DesignerPorts, GenerationRequest, GenerationResult } from '../../store/ports';
import { GeneratePanel } from '../GeneratePanel';
import { countElements, dslFromAi, dslFromAiText, extractJson } from '../dsl-from-ai';
import {
  MAX_SKETCH_BYTES,
  createSketchFromDataUrl,
  createSketchFromPath,
  describeSketch,
  isVisionSupported,
  validateSketchFile,
} from '../sketch-import';

function registry(): ComponentRegistry {
  const instance = new ComponentRegistry();
  registerBuiltinComponents(instance);
  return instance;
}

const CONTEXT = {
  id: 'ai-page',
  projectId: 'P1',
  name: 'AI 登录页',
  platform: 'web' as const,
  route: '/ai-login',
  registry: registry(),
};

/** 一份合法的模型输出（含中文显示名与业务结构） */
function validCandidate() {
  const login = createLoginPageDsl();
  return {
    name: '登录页',
    platform: 'web',
    route: '/login',
    tree: login.tree,
    state: login.state,
    apiDeps: login.apiDeps,
  };
}

describe('T3-11 AI 生成结果校验', () => {
  it('extractJson 容忍代码块与前后说明文字', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('这是结果：{"a":2} 请查收')).toEqual({ a: 2 });
    expect(extractJson('完全不是 JSON')).toBeNull();
  });

  it('合法候选结果通过校验并保持可编辑结构', () => {
    const result = dslFromAi(validCandidate(), CONTEXT);
    expect(result.dsl).not.toBeNull();
    expect(result.issues).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(countElements(result.dsl!)).toBe(walkElements(createLoginPageDsl().tree).length);
    // 落地后仍可自由编辑：可直接在结果上做结构操作
    const dsl = result.dsl!;
    expect(findById(dsl.tree, 'el-15')).not.toBeNull();
  });

  it('未知组件类型降级为 Container 并给出提示', () => {
    const candidate = {
      tree: {
        id: 'root',
        type: 'Container',
        name: '页面',
        children: [{ id: 'x1', type: 'MagicWidget', name: '未知组件' }],
      },
    };
    const result = dslFromAi(candidate, CONTEXT);
    expect(result.dsl).not.toBeNull();
    expect(result.degraded).toBe(true);
    const degraded = findById(result.dsl!.tree, 'x1');
    expect(degraded?.type).toBe('Container');
    expect(degraded?.name).toBe('未知组件');
    expect(result.issues.map((issue) => issue.kind)).toContain('unknown-component');
  });

  it('嵌套超限被裁剪并提示', () => {
    let node: Record<string, unknown> = { id: 'n-9', type: 'Text' };
    for (let level = 8; level >= 0; level -= 1) {
      node = { id: `n-${level}`, type: 'Container', children: [node] };
    }
    const result = dslFromAi({ tree: node }, CONTEXT);
    expect(result.dsl).not.toBeNull();
    expect(result.issues.map((issue) => issue.kind)).toContain('depth-trimmed');
    const walked = walkElements(result.dsl!.tree);
    expect(walked.length).toBeLessThanOrEqual(8);
    expect(walked.every((entry) => entry.depth < 8)).toBe(true);
  });

  it('结构不可修复时返回 null（调用方据此走降级链）', () => {
    expect(dslFromAi(null, CONTEXT).dsl).toBeNull();
    expect(dslFromAi('not-json', CONTEXT).dsl).toBeNull();
    expect(dslFromAi({ tree: { type: 'Container', style: 'bad' } }, CONTEXT).dsl).not.toBeNull();
  });

  it('dslFromAiText 一步完成文本抽取与校验', () => {
    const result = dslFromAiText(
      `好的，这是页面：\n\`\`\`json\n${JSON.stringify(validCandidate())}\n\`\`\``,
      CONTEXT,
    );
    expect(result.dsl?.route).toBe('/login');
  });

  it('缺少必需字段时自动补齐（id / projectId / 平台 / 路由）', () => {
    const result = dslFromAi({ tree: { id: 'root', type: 'Container' } }, CONTEXT);
    expect(result.dsl?.projectId).toBe('P1');
    expect(result.dsl?.platform).toBe('web');
    expect(result.dsl?.route).toBe('/ai-login');
  });
});

describe('T3-11 草图导入', () => {
  it('校验图片类型与体积上限', () => {
    expect(validateSketchFile({ name: 'a.png', size: 1024, type: 'image/png' })).toEqual({
      ok: true,
    });
    expect(validateSketchFile({ name: 'a.gif', size: 1024, type: 'image/gif' }).ok).toBe(false);
    expect(validateSketchFile({ name: 'a.png', size: 0, type: 'image/png' }).ok).toBe(false);
    const tooBig = validateSketchFile({
      name: 'a.png',
      size: MAX_SKETCH_BYTES + 1,
      type: 'image/png',
    });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.message).toContain('8MB');
  });

  it('dataURL 转载荷并计算体积', () => {
    const ok = createSketchFromDataUrl('data:image/png;base64,aGVsbG8=', 'login.png');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.payload.mime).toBe('image/png');
      expect(ok.payload.sizeBytes).toBe(5);
      expect(describeSketch(ok.payload)).toContain('login.png');
    }
    expect(createSketchFromDataUrl('data:image/gif;base64,aGVsbG8=').ok).toBe(false);
  });

  it('路径载荷按扩展名推断 MIME', () => {
    expect(createSketchFromPath('C:/tmp/login.JPG').mime).toBe('image/jpeg');
    expect(createSketchFromPath('C:/tmp/login.webp').mime).toBe('image/webp');
    expect(createSketchFromPath('C:/tmp/login').mime).toBe('image/png');
  });

  it('无设计端口时视觉能力为不支持', () => {
    expect(isVisionSupported(undefined)).toBe(false);
    expect(
      isVisionSupported({
        supportsVision: true,
        generatePage: async () => ({ candidate: null, raw: '' }),
      }),
    ).toBe(true);
  });
});

describe('T3-11 生成面板（含降级链与页面记忆写入）', () => {
  function setup(design: DesignerPorts['design'], memory: DesignerPorts['memory'] = undefined) {
    const onGenerated = vi.fn();
    render(
      <DesignerProvider ports={{ ...(design ? { design } : {}), ...(memory ? { memory } : {}) }}>
        <GeneratePanel
          projectId="P1"
          pageId="login"
          platform="web"
          route="/login"
          onGenerated={onGenerated}
        />
      </DesignerProvider>,
    );
    return { onGenerated };
  }

  it('未接入生成能力时给出中文错误', async () => {
    setup(undefined);
    fireEvent.change(screen.getByLabelText('界面描述'), { target: { value: '做一个登录页' } });
    fireEvent.click(screen.getByTestId('generate-button'));
    expect(await screen.findByTestId('generate-status')).toHaveTextContent('未接入 AI 生成能力');
  });

  it('描述为空时提示先填写', async () => {
    setup({ supportsVision: false, generatePage: async () => ({ candidate: null, raw: '' }) });
    fireEvent.click(screen.getByTestId('generate-button'));
    expect(await screen.findByTestId('generate-status')).toHaveTextContent('请先描述你想要的界面');
  });

  it('生成成功：落地 DSL、提示元素数、写入页面记忆', async () => {
    const writePageStructure = vi.fn();
    const generatePage = vi.fn(async (_request: GenerationRequest): Promise<GenerationResult> => ({
      candidate: validCandidate(),
      raw: '',
    }));
    const { onGenerated } = setup({ supportsVision: false, generatePage }, { writePageStructure });

    fireEvent.change(screen.getByLabelText('界面描述'), { target: { value: '做一个登录页' } });
    fireEvent.click(screen.getByTestId('generate-button'));

    expect(await screen.findByTestId('generate-status')).toHaveTextContent('已生成 20 个元素');
    expect(onGenerated).toHaveBeenCalledTimes(1);
    const [dsl, meta] = onGenerated.mock.calls[0] as [unknown, { attempts: number }];
    expect(dsl).toBeTruthy();
    expect(meta.attempts).toBe(1);
    // 自动写入页面记忆
    expect(writePageStructure).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'P1', pageId: 'login' }),
    );
  });

  it('解析失败重试 1 次，仍失败则报中文错误', async () => {
    const generatePage = vi.fn(async (): Promise<GenerationResult> => ({
      candidate: { tree: 'bad' },
      raw: 'not-json',
    }));
    const { onGenerated } = setup({ supportsVision: false, generatePage });

    fireEvent.change(screen.getByLabelText('界面描述'), { target: { value: '做一个登录页' } });
    fireEvent.click(screen.getByTestId('generate-button'));

    expect(await screen.findByTestId('generate-status')).toHaveTextContent('生成失败');
    expect(generatePage).toHaveBeenCalledTimes(2); // 首次 + 重试 1 次
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it('模型不支持视觉时禁用草图入口并提示', () => {
    setup({ supportsVision: false, generatePage: async () => ({ candidate: null, raw: '' }) });
    expect(screen.getByTestId('vision-unsupported')).toHaveTextContent('不支持图片理解');
    expect(screen.getByLabelText('上传草图')).toBeDisabled();
    expect(screen.getByLabelText('使用草图')).toBeDisabled();
  });

  it('支持视觉时可上传草图（选择后展示草图信息）', async () => {
    setup({
      supportsVision: true,
      generatePage: async () => ({ candidate: validCandidate(), raw: '' }),
    });
    expect(screen.queryByTestId('vision-unsupported')).toBeNull();
    const input = screen.getByLabelText('上传草图') as HTMLInputElement;
    const file = new File(['fake'], 'sketch.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 2048 });
    // jsdom 的 FileReader 可用，dataURL 由内容生成
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByTestId('generate-status')).toHaveTextContent('已选择草图');
  });
});
