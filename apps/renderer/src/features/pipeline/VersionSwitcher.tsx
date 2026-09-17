import type { ArtifactVersion, PipelineStage } from '@ec/pipeline';
import { Select } from '@ec/ui';

import { usePipelineApi } from './pipeline-api';

/**
 * 版本切换（T5-02 要点 3 / FR-PIPE-02）。
 * - 下拉列出全部历史版本（v1/v2/…）；
 * - 切换后调 api.switchVersion 改指针，并通知下游"文档已更新，是否重新生成"；
 * - 正在查看历史版本时给出提示条。
 */

export interface VersionSwitcherProps {
  projectId: string;
  stage: PipelineStage;
  versions: readonly ArtifactVersion[];
  /** 当前生效版本（activeVersion） */
  activeVersion: number;
  /** 当前回看版本（≠ activeVersion 时展示历史提示） */
  viewingVersion: number;
  /** 版本切换回调（父层负责读取新内容） */
  onSwitch: (version: number) => void;
}

export function VersionSwitcher({ projectId, stage, versions, activeVersion, viewingVersion, onSwitch }: VersionSwitcherProps): JSX.Element {
  const api = usePipelineApi();
  const latest = versions.reduce((max, version) => Math.max(max, version.version), 0);
  const isHistorical = viewingVersion > 0 && viewingVersion < latest;

  const options = [...versions]
    .sort((a, b) => b.version - a.version)
    .map((version) => ({
      value: String(version.version),
      label: `v${version.version}${version.version === latest ? '（最新）' : ''}${version.version === activeVersion ? '（生效中）' : ''}`,
    }));

  return (
    <div className="ec-pipe-versions" data-testid="version-switcher">
      <Select
        aria-label="产物版本"
        value={String(viewingVersion)}
        options={options}
        onChange={(value) => {
          const version = Number(value);
          if (Number.isNaN(version)) return;
          api.switchVersion(projectId, stage, version);
          if (version < latest) {
            // 切换回历史版本：提示"正在查看历史版本"，不强制重建下游
            api.notifyDownstream(projectId, stage, `已切换到历史版本 v${version}（最新为 v${latest}），下游产物不会自动变更`);
          }
          onSwitch(version);
        }}
      />
      {isHistorical && (
        <div className="ec-pipe-versions__hint" data-testid="version-historical-hint">
          正在查看历史版本 v{viewingVersion}（最新 v{latest}），切换不会影响已生成的下游产物
        </div>
      )}
    </div>
  );
}
