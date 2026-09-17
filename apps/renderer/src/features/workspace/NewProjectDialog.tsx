/**
 * NewProjectDialog（T9-01 / FR-WSP-02）：新建项目四类来源。
 *
 * ① 空白 / ② 模板（内置 Web 管理后台 / 移动端 App / 官网落地页）
 * ③ 从 Git 仓库导入（克隆 + 识别项目类型 + 生成项目记忆初稿）
 * ④ 从需求文档导入（解析 Markdown 提取功能清单）
 */

import { useCallback, useMemo, useState } from 'react';
import { Button, EmptyState, Input, Modal, Progress, Tabs, Tag, Textarea } from '@ec/ui';
import {
  PROJECT_TEMPLATES,
  countTemplateElements,
  parseRequirementDocument,
  projectNameFromDigest,
  type ProjectSummary,
  type RequirementDigest,
} from '@ec/core';

import { TargetPlatformPicker } from './ProjectSettings';
import { useWorkspace } from './workspace-api';
import type { TargetPlatform } from '@ec/pipeline';

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: ProjectSummary) => void;
}

export function NewProjectDialog({ open, onClose, onCreated }: NewProjectDialogProps): JSX.Element {
  const api = useWorkspace();
  const [source, setSource] = useState('blank');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [platforms, setPlatforms] = useState<TargetPlatform[]>([]);
  const [templateId, setTemplateId] = useState(PROJECT_TEMPLATES[0]!.id);
  const [gitUrl, setGitUrl] = useState('');
  const [targetDir, setTargetDir] = useState('');
  const [progress, setProgress] = useState<{ ratio: number; message: string } | null>(null);
  const [docText, setDocText] = useState('');
  const [digest, setDigest] = useState<RequirementDigest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTemplate = useMemo(
    () => PROJECT_TEMPLATES.find((template) => template.id === templateId) ?? PROJECT_TEMPLATES[0]!,
    [templateId],
  );

  const reset = useCallback(() => {
    setSource('blank');
    setName('');
    setDescription('');
    setPlatforms([]);
    setGitUrl('');
    setTargetDir('');
    setDocText('');
    setDigest(null);
    setProgress(null);
    setError(null);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let project: ProjectSummary;
      if (source === 'template') {
        project = await api.createFromTemplate({
          templateId,
          name: name.trim() || selectedTemplate.name,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
      } else if (source === 'git') {
        project = await api.importFromGit({
          url: gitUrl.trim(),
          ...(name.trim() ? { projectName: name.trim() } : {}),
          targetDir: targetDir.trim(),
          onProgress: (ratio, message) => setProgress({ ratio, message }),
        });
      } else if (source === 'doc') {
        if (!digest) throw new Error('请先解析需求文档，确认功能清单后再创建项目');
        project = await api.createFromDigest({ digest, name: name.trim() || projectNameFromDigest(digest) });
      } else {
        project = await api.createProject({
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          targetPlatforms: platforms,
        });
      }
      reset();
      onCreated(project);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [
    api,
    description,
    digest,
    gitUrl,
    name,
    onCreated,
    platforms,
    reset,
    selectedTemplate.name,
    source,
    targetDir,
    templateId,
  ]);

  const parseDoc = useCallback(() => {
    setDigest(parseRequirementDocument(docText));
  }, [docText]);

  const canSubmit =
    source === 'blank'
      ? name.trim().length > 0
      : source === 'template'
        ? true
        : source === 'git'
          ? gitUrl.trim().length > 0 && targetDir.trim().length > 0
          : digest !== null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="新建项目"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void create()}>
            创建项目
          </Button>
        </>
      }
    >
      <Tabs
        items={[
          { key: 'blank', label: '空白项目' },
          { key: 'template', label: '从模板' },
          { key: 'git', label: '从 Git 仓库' },
          { key: 'doc', label: '从需求文档' },
        ]}
        value={source}
        onChange={setSource}
        // eslint-disable-next-line react/no-children-prop -- Tabs 的 children 是渲染函数
        children={(active) => (
          <div className="ec-ws__form">
            {active === 'blank' ? (
              <>
                <label className="ec-ws__field">
                  <span>项目名称</span>
                  <Input value={name} onChange={setName} aria-label="新项目名称" placeholder="例如：订单管理系统" />
                </label>
                <label className="ec-ws__field">
                  <span>描述（可选）</span>
                  <Textarea value={description} onChange={setDescription} rows={2} aria-label="新项目描述" />
                </label>
                <div className="ec-ws__field">
                  <span>目标端</span>
                  <TargetPlatformPicker value={platforms} onChange={setPlatforms} disabled={busy} />
                </div>
              </>
            ) : null}

            {active === 'template' ? (
              <>
                <ul className="ec-ws__templates" aria-label="内置模板">
                  {PROJECT_TEMPLATES.map((template) => (
                    <li key={template.id}>
                      <label className="ec-ws__template" data-selected={template.id === templateId ? 'true' : 'false'}>
                        <input
                          type="radio"
                          name="template"
                          value={template.id}
                          checked={template.id === templateId}
                          onChange={() => setTemplateId(template.id)}
                          aria-label={template.name}
                        />
                        <span className="ec-ws__template-name">{template.name}</span>
                        <span className="ec-ws__hint">{template.description}</span>
                        <span className="ec-ws__template-meta">
                          <Tag color="info">{`${template.pages.length} 页`}</Tag>
                          <Tag color="neutral">{`${countTemplateElements(template)} 个元素`}</Tag>
                          {template.targetPlatforms.map((platform) => (
                            <Tag key={platform} color="primary">
                              {platform}
                            </Tag>
                          ))}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <label className="ec-ws__field">
                  <span>项目名称（留空则用模板名）</span>
                  <Input value={name} onChange={setName} aria-label="模板项目名称" placeholder={selectedTemplate.name} />
                </label>
              </>
            ) : null}

            {active === 'git' ? (
              <>
                <label className="ec-ws__field">
                  <span>仓库地址</span>
                  <Input
                    value={gitUrl}
                    onChange={setGitUrl}
                    aria-label="Git 仓库地址"
                    placeholder="https://github.com/team/repo.git 或 git@github.com:team/repo.git"
                  />
                </label>
                <label className="ec-ws__field">
                  <span>克隆到目录</span>
                  <Input value={targetDir} onChange={setTargetDir} aria-label="克隆目录" placeholder="D:\\projects\\repo" />
                </label>
                <label className="ec-ws__field">
                  <span>项目名称（留空则取仓库名）</span>
                  <Input value={name} onChange={setName} aria-label="Git 项目名称" placeholder="repo" />
                </label>
                {progress ? (
                  <div className="ec-ws__field">
                    <span>{progress.message}</span>
                    <Progress value={Math.round(progress.ratio * 100)} max={100} />
                  </div>
                ) : null}
                <p className="ec-ws__hint">
                  导入后会扫描依赖清单识别项目类型，并生成项目记忆初稿（技术标签 + 代码约定）。
                </p>
              </>
            ) : null}

            {active === 'doc' ? (
              <>
                <label className="ec-ws__field">
                  <span>粘贴需求文档（Markdown / 纯文本）</span>
                  <Textarea
                    value={docText}
                    onChange={setDocText}
                    rows={8}
                    aria-label="需求文档内容"
                    placeholder={'# 需求文档\n\n## 功能\n- 登录：支持邮箱与第三方登录\n- 订单创建：支持多商品下单\n\n## 页面清单\n- 首页 /home\n'}
                  />
                </label>
                <Button variant="secondary" disabled={!docText.trim()} onClick={parseDoc}>
                  解析文档
                </Button>
                {digest ? (
                  <div className="ec-ws__digest" aria-label="解析结果">
                    <p className="ec-ws__notice">{digest.summary}</p>
                    <ul>
                      {digest.features.slice(0, 8).map((feature) => (
                        <li key={`${feature.name}-${feature.line}`}>
                          {`${feature.name}${feature.description ? `：${feature.description}` : ''}`}
                        </li>
                      ))}
                    </ul>
                    {digest.features.length > 8 ? (
                      <p className="ec-ws__hint">{`另有 ${digest.features.length - 8} 项功能，将在创建后写入项目记忆。`}</p>
                    ) : null}
                    {digest.warnings.map((warning) => (
                      <p key={warning} className="ec-ws__warning">
                        {warning}
                      </p>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="尚未解析" description="粘贴文档后点「解析文档」，确认功能清单再创建项目。" />
                )}
                <label className="ec-ws__field">
                  <span>项目名称（留空则取文档标题）</span>
                  <Input value={name} onChange={setName} aria-label="文档项目名称" placeholder="由文档标题推断" />
                </label>
              </>
            ) : null}

            {error ? <p className="ec-ws__error">{error}</p> : null}
          </div>
        )}
      />
    </Modal>
  );
}
