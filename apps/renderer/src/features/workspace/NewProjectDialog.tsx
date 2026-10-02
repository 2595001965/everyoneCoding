/**
 * NewProjectDialog（T9-01 / FR-WSP-02；V2-D01 扩展）：
 *
 * ① 空白 / ② 模板（内置 Web 管理后台 / 移动端 App / 官网落地页）
 * ③ 从 Git 仓库导入（克隆 + 识别项目类型 + 生成项目记忆初稿）
 * ④ 打开文件夹（直接关联原目录【默认，不复制】或复制导入，统一静态识别）
 * ⑤ 从 ZIP 导入（安全解压到新目录 + 统一静态识别）
 * ⑥ 从需求文档导入（解析 Markdown 提取功能清单）
 *
 * 文件夹/ZIP 选择走外壳 dialog 能力（Electron/Tauri/mock 三实现），域只收路径；
 * 选择器取消返回 null 时不发起任何域调用（不写文件）。导入前先做只读预扫描，
 * 用户确认识别结论（子工程/命令/包管理器/环境变量名/支持边界）后再导入。
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
import { useWorkspace, type SourcePreview, type WorkspaceImportProgress } from './workspace-api';
import { pickDirectory, pickZipFile } from '../../runtime/shell-dialog';
import type { TargetPlatform } from '@ec/pipeline';

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: ProjectSummary) => void;
}

const SUPPORT_LEVEL_LABEL: Record<string, string> = {
  supported: '支持',
  partial: '部分支持',
  unsupported: '不支持',
  unknown: '未知',
};

const ROLE_LABEL: Record<string, string> = {
  frontend: '前端',
  backend: '后端',
  fullstack: '前后端',
  library: '库',
  unknown: '未识别',
};

/**
 * 识别结论预览（V2-SRC-03/04 的"用户可确认"承载）：
 * 子工程角色/框架/包管理器、建议命令与端口、环境变量**名称**（值不入 UI）、
 * 支持边界标签与扫描备注。运行计划未识别时如实说明，不编造命令。
 */
function DetectionPreview({ preview }: { preview: SourcePreview }): JSX.Element {
  const { detection } = preview;
  return (
    <div className="ec-ws__digest" aria-label="识别结果">
      {detection.subProjects.map((sub) => (
        <div key={sub.subProjectId} className="ec-ws__subproject">
          <p className="ec-ws__subproject-title">
            <strong>{sub.entryHints[0] ?? '.'}</strong>
            <Tag color="neutral">{ROLE_LABEL[sub.role] ?? sub.role}</Tag>
            {sub.framework !== null ? <Tag color="primary">{sub.framework}</Tag> : null}
            <Tag
              color={
                sub.supportLevel === 'supported'
                  ? 'success'
                  : sub.supportLevel === 'unknown'
                    ? 'warning'
                    : 'info'
              }
            >
              {SUPPORT_LEVEL_LABEL[sub.supportLevel] ?? sub.supportLevel}
            </Tag>
          </p>
          <p className="ec-ws__hint">
            {sub.language ?? '语言未知'}
            {sub.packageManager !== null
              ? ` · 包管理器：${sub.packageManager}`
              : ' · 未识别包管理器'}
            {sub.confidence !== null ? ` · 置信度 ${(sub.confidence * 100).toFixed(0)}%` : ''}
          </p>
          {sub.suggestedRunPlan === null ? (
            <p className="ec-ws__hint">
              未生成运行命令（静态托管或未知栈——运行前需人工提供配置）。
            </p>
          ) : (
            <ul className="ec-ws__plan">
              {sub.suggestedRunPlan.startupOrder.map((serviceId) => {
                const service = sub.suggestedRunPlan?.services.find(
                  (item) => item.serviceId === serviceId,
                );
                if (!service) return null;
                return (
                  <li key={serviceId}>
                    {`${service.command} ${service.args.join(' ')}`}
                    {service.portHint !== null ? `（端口 ${service.portHint}）` : ''}
                  </li>
                );
              })}
              {sub.suggestedRunPlan.envVarNames.length > 0 ? (
                <li>{`环境变量（仅名称，值在本地受保护配置中输入）：${sub.suggestedRunPlan.envVarNames.join('、')}`}</li>
              ) : null}
            </ul>
          )}
        </div>
      ))}
      {detection.notes.length > 0
        ? detection.notes.map((note) => (
            <p key={note} className="ec-ws__notice">
              {note}
            </p>
          ))
        : null}
    </div>
  );
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
  const [progress, setProgress] = useState<WorkspaceImportProgress | null>(null);
  const [docText, setDocText] = useState('');
  const [digest, setDigest] = useState<RequirementDigest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // V2-D01 文件接入状态
  const [folderPath, setFolderPath] = useState('');
  const [folderMode, setFolderMode] = useState<'link' | 'copy'>('link');
  const [zipPath, setZipPath] = useState('');
  const [zipTarget, setZipTarget] = useState('');
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [importToken, setImportToken] = useState<string | null>(null);

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
    setFolderPath('');
    setFolderMode('link');
    setZipPath('');
    setZipTarget('');
    setPreview(null);
    setImportToken(null);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  /** 生成一次导入的取消令牌（cancelSourceImport 据此中止复制/解压循环） */
  const newImportToken = useCallback(
    () => `imp-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    [],
  );

  /** 只读预扫描：不建项目不写文件；失败仅提示，不阻断导入 */
  const runPreview = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (trimmed.length === 0) {
        setPreview(null);
        return;
      }
      try {
        setPreview(await api.previewSourceDetection(trimmed));
        setError(null);
      } catch (cause: unknown) {
        setPreview(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api],
  );

  const pickFolder = useCallback(() => {
    void pickDirectory('选择要打开的源码目录').then((picked) => {
      if (picked === null) return; // 取消选择：不发起任何调用、不写文件
      setFolderPath(picked);
      void runPreview(picked);
    });
  }, [runPreview]);

  const pickZip = useCallback(() => {
    void pickZipFile('选择 ZIP 归档').then((picked) => {
      if (picked === null) return;
      setZipPath(picked);
      void runPreview(picked);
    });
  }, [runPreview]);

  const pickZipTarget = useCallback(() => {
    void pickDirectory('选择解压目标目录（须为空目录）').then((picked) => {
      if (picked === null) return;
      setZipTarget(picked);
    });
  }, []);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    const token = newImportToken();
    setImportToken(token);
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
          onProgress: (next) => setProgress(next),
        });
      } else if (source === 'folder') {
        project = await api.importFromFolder({
          path: folderPath.trim(),
          mode: folderMode,
          ...(name.trim() ? { projectName: name.trim() } : {}),
          importToken: token,
          onProgress: (next) => setProgress(next),
        });
      } else if (source === 'zip') {
        project = await api.importFromZip({
          zipPath: zipPath.trim(),
          targetDir: zipTarget.trim(),
          ...(name.trim() ? { projectName: name.trim() } : {}),
          importToken: token,
          onProgress: (next) => setProgress(next),
        });
      } else if (source === 'doc') {
        if (!digest) throw new Error('请先解析需求文档，确认功能清单后再创建项目');
        project = await api.createFromDigest({
          digest,
          name: name.trim() || projectNameFromDigest(digest),
        });
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
      setImportToken(null);
    }
  }, [
    api,
    description,
    digest,
    folderMode,
    folderPath,
    gitUrl,
    name,
    newImportToken,
    onCreated,
    platforms,
    reset,
    selectedTemplate.name,
    source,
    targetDir,
    templateId,
    zipPath,
    zipTarget,
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
          : source === 'folder'
            ? folderPath.trim().length > 0
            : source === 'zip'
              ? zipPath.trim().length > 0 && zipTarget.trim().length > 0
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
          <Button variant="ghost" onClick={close} disabled={busy}>
            取消
          </Button>
          {busy && importToken !== null ? (
            // 复制/解压中的取消（V2-SRC-10）：中止后只清理本次创建的临时内容
            <Button
              variant="secondary"
              onClick={() => {
                if (importToken !== null) void api.cancelSourceImport(importToken);
              }}
            >
              取消导入
            </Button>
          ) : null}
          <Button
            variant="primary"
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void create()}
          >
            创建项目
          </Button>
        </>
      }
    >
      <Tabs
        items={[
          { key: 'blank', label: '空白项目' },
          { key: 'template', label: '从模板' },
          { key: 'folder', label: '打开文件夹' },
          { key: 'zip', label: '从 ZIP 导入' },
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
                  <Input
                    value={name}
                    onChange={setName}
                    aria-label="新项目名称"
                    placeholder="例如：订单管理系统"
                  />
                </label>
                <label className="ec-ws__field">
                  <span>描述（可选）</span>
                  <Textarea
                    value={description}
                    onChange={setDescription}
                    rows={2}
                    aria-label="新项目描述"
                  />
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
                      <label
                        className="ec-ws__template"
                        data-selected={template.id === templateId ? 'true' : 'false'}
                      >
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
                  <Input
                    value={name}
                    onChange={setName}
                    aria-label="模板项目名称"
                    placeholder={selectedTemplate.name}
                  />
                </label>
              </>
            ) : null}

            {active === 'folder' ? (
              <>
                <div className="ec-ws__field">
                  <span>源码目录</span>
                  <div className="ec-ws__picker-row">
                    <Input
                      value={folderPath}
                      onChange={setFolderPath}
                      aria-label="源码目录路径"
                      placeholder="D:\projects\my-app（支持中文与空格路径）"
                    />
                    <Button variant="secondary" disabled={busy} onClick={pickFolder}>
                      选择目录…
                    </Button>
                  </div>
                </div>
                <div className="ec-ws__field" role="radiogroup" aria-label="接入方式">
                  <span>接入方式</span>
                  <label className="ec-ws__radio">
                    <input
                      type="radio"
                      name="folder-mode"
                      checked={folderMode === 'link'}
                      onChange={() => setFolderMode('link')}
                      disabled={busy}
                    />
                    直接关联原目录（默认：不复制不转换，源码原地使用，未提交改动保持原样）
                  </label>
                  <label className="ec-ws__radio">
                    <input
                      type="radio"
                      name="folder-mode"
                      checked={folderMode === 'copy'}
                      onChange={() => setFolderMode('copy')}
                      disabled={busy}
                    />
                    复制到工作区（源目录不动，后续修改落在副本）
                  </label>
                </div>
                <label className="ec-ws__field">
                  <span>项目名称（留空则取目录名）</span>
                  <Input
                    value={name}
                    onChange={setName}
                    aria-label="文件夹项目名称"
                    placeholder="my-app"
                  />
                </label>
                <Button
                  variant="secondary"
                  disabled={busy || !folderPath.trim()}
                  onClick={() => void runPreview(folderPath)}
                >
                  识别工程
                </Button>
                {preview !== null ? <DetectionPreview preview={preview} /> : null}
                {progress ? (
                  <div className="ec-ws__field">
                    <span>{progress.message}</span>
                    <Progress
                      {...(progress.ratio === null
                        ? { indeterminate: true }
                        : { value: Math.round(progress.ratio * 100), max: 100 })}
                    />
                  </div>
                ) : null}
                <p className="ec-ws__hint">
                  导入过程只读扫描源码（不执行工程脚本）；首次安装依赖/运行命令前会再次请求确认。
                </p>
              </>
            ) : null}

            {active === 'zip' ? (
              <>
                <div className="ec-ws__field">
                  <span>ZIP 归档</span>
                  <div className="ec-ws__picker-row">
                    <Input
                      value={zipPath}
                      onChange={setZipPath}
                      aria-label="ZIP 文件路径"
                      placeholder="D:\downloads\my-app.zip"
                    />
                    <Button variant="secondary" disabled={busy} onClick={pickZip}>
                      选择文件…
                    </Button>
                  </div>
                </div>
                <div className="ec-ws__field">
                  <span>解压到目录（须为空目录；已有内容不会被覆盖）</span>
                  <div className="ec-ws__picker-row">
                    <Input
                      value={zipTarget}
                      onChange={setZipTarget}
                      aria-label="解压目标目录"
                      placeholder="D:\projects\my-app"
                    />
                    <Button variant="secondary" disabled={busy} onClick={pickZipTarget}>
                      选择目录…
                    </Button>
                  </div>
                </div>
                <label className="ec-ws__field">
                  <span>项目名称（留空则取 ZIP 文件名）</span>
                  <Input
                    value={name}
                    onChange={setName}
                    aria-label="ZIP 项目名称"
                    placeholder="my-app"
                  />
                </label>
                <Button
                  variant="secondary"
                  disabled={busy || !zipPath.trim()}
                  onClick={() => void runPreview(zipPath)}
                >
                  识别工程
                </Button>
                {preview !== null ? <DetectionPreview preview={preview} /> : null}
                {progress ? (
                  <div className="ec-ws__field">
                    <span>{progress.message}</span>
                    <Progress
                      {...(progress.ratio === null
                        ? { indeterminate: true }
                        : { value: Math.round(progress.ratio * 100), max: 100 })}
                    />
                  </div>
                ) : null}
                <p className="ec-ws__hint">
                  解压前做安全校验（路径穿越 / 盘符 / 大小写冲突 / 解压炸弹），任一命中即整体拒绝；
                  解压到新目录，不会覆盖已有内容。
                </p>
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
                  <Input
                    value={targetDir}
                    onChange={setTargetDir}
                    aria-label="克隆目录"
                    placeholder="D:\\projects\\repo"
                  />
                </label>
                <label className="ec-ws__field">
                  <span>项目名称（留空则取仓库名）</span>
                  <Input
                    value={name}
                    onChange={setName}
                    aria-label="Git 项目名称"
                    placeholder="repo"
                  />
                </label>
                {progress ? (
                  <div className="ec-ws__field">
                    <span>{progress.message}</span>
                    {/* 扫描/落库阶段比例不可知，用不确定进度而不是假装 100% */}
                    <Progress
                      {...(progress.ratio === null
                        ? { indeterminate: true }
                        : { value: Math.round(progress.ratio * 100), max: 100 })}
                    />
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
                    placeholder={
                      '# 需求文档\n\n## 功能\n- 登录：支持邮箱与第三方登录\n- 订单创建：支持多商品下单\n\n## 页面清单\n- 首页 /home\n'
                    }
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
                  <EmptyState
                    title="尚未解析"
                    description="粘贴文档后点「解析文档」，确认功能清单再创建项目。"
                  />
                )}
                <label className="ec-ws__field">
                  <span>项目名称（留空则取文档标题）</span>
                  <Input
                    value={name}
                    onChange={setName}
                    aria-label="文档项目名称"
                    placeholder="由文档标题推断"
                  />
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
