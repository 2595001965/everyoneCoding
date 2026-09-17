import type { GlobalSettings, ProjectSettings, Settings } from './settings-schema';
import {
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_SETTINGS,
  globalSettingsSchema,
  migrateSettings,
  projectSettingsSchema,
} from './settings-schema';

/**
 * 设置中心。
 *
 * 设计要点：
 * - 全局 / 项目两级，项目级未设置的项回落到全局
 * - 修改即时生效：订阅者在同一 tick 内收到通知，无需重启
 * - 非法值由 zod 拦截并抛出，绝不写入脏配置
 */

export type SettingsListener = (settings: Settings) => void;

export class SettingsStore {
  private state: Settings;
  private readonly listeners = new Set<SettingsListener>();

  constructor(initial: Partial<Settings> = {}) {
    this.state = migrateSettings({ ...DEFAULT_SETTINGS, ...initial });
  }

  get(): Settings {
    return this.state;
  }

  getGlobal(): GlobalSettings {
    return this.state.global;
  }

  /** 项目级设置与全局合并：项目未显式设置的项使用全局值 */
  forProject(projectId: string): ProjectSettings {
    const project = this.state.projects[projectId];
    if (!project) {
      return {
        ...DEFAULT_PROJECT_SETTINGS,
        memoryWritePolicy: this.state.global.ai.memoryWritePolicy,
        codeWritePolicy: this.state.global.ai.codeWritePolicy,
      };
    }
    return {
      ...project,
      memoryWritePolicy: project.memoryWritePolicy ?? this.state.global.ai.memoryWritePolicy,
      codeWritePolicy: project.codeWritePolicy ?? this.state.global.ai.codeWritePolicy,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 局部更新全局设置；zod 校验失败时抛错且不改变状态 */
  updateGlobal(patch: Partial<GlobalSettings>): Settings {
    const merged = { ...this.state.global, ...patch };
    const parsed = globalSettingsSchema.parse(merged);
    this.state = { ...this.state, global: parsed };
    this.emit();
    return this.state;
  }

  /** 局部更新项目设置 */
  updateProject(projectId: string, patch: Partial<ProjectSettings>): Settings {
    const current = this.state.projects[projectId] ?? DEFAULT_PROJECT_SETTINGS;
    const parsed = projectSettingsSchema.parse({ ...current, ...patch });
    this.state = {
      ...this.state,
      projects: { ...this.state.projects, [projectId]: parsed },
    };
    this.emit();
    return this.state;
  }

  /** 删除项目级设置（回到继承全局） */
  resetProject(projectId: string): Settings {
    const projects = { ...this.state.projects };
    delete projects[projectId];
    this.state = { ...this.state, projects };
    this.emit();
    return this.state;
  }

  toJSON(): string {
    return JSON.stringify(this.state, null, 2);
  }

  /** 从 JSON 载入（自动迁移） */
  static fromJSON(json: string): SettingsStore {
    return new SettingsStore(migrateSettings(JSON.parse(json) as unknown));
  }

  /** 恢复出厂设置（保留版本号） */
  reset(): Settings {
    this.state = { ...DEFAULT_SETTINGS };
    this.emit();
    return this.state;
  }
}

/** 默认单例，供渲染层直接订阅；测试请用 new SettingsStore() 隔离状态 */
export const settingsStore = new SettingsStore();
