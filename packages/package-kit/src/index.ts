/**
 * @ec/package-kit —— .ecpkg 归档读写（Wave 8：T8-01 ~ T8-04）
 *
 * 约束：跨包引用只允许通过本单一入口，禁止深路径导入。
 * 本包为 Node 侧包（外壳装配时使用），渲染层经 `globalThis.__EC_PACKAGE__` 端口
 * 间接使用（见 apps/renderer/src/features/package/package-api.tsx）。
 */

/* ------------------------------ T8-01：包格式 ------------------------------ */

/** 格式版本与兼容策略 */
export * from './format/version';
/** §14.1 布局（路径构造、分区分类、结构断言） */
export * from './format/layout';
/** manifest 领域模型与 zod 校验 */
export * from './format/manifest';
/** 逐文件 SHA-256 校验 */
export * from './format/checksum';
/** 可选 Ed25519 签名 */
export * from './format/signature';

/** ZIP 容器（零依赖手写，DEFLATE，流式） */
export * from './container/zip';
/** 加密信封（AES-256-GCM + PBKDF2，口令不落盘） */
export * from './container/envelope';

/** `.ecpkg` 写入器 */
export * from './writer';
/** `.ecpkg` 读取器 */
export * from './reader';

/* ------------------------------ T8-02：导出流水线 ------------------------------ */

/** 导出契约类型（ExportSelection / ExportSourcePort / ExportJobRequest …） */
export * from './export/export-types';
/** 范围选择与导出方案（preset） */
export * from './export/scope-selector';
/** 排除规则（默认规则 + .ecignore，gitignore 子集） */
export * from './export/exclude-rules';
/** 脱敏（复用 @ec/core 规则 + 包内扫描自检） */
export * from './export/redactor';
/** 加密封装（明文 ZIP → AES-256-GCM 信封） */
export * from './export/encryptor';
/** 导出进度追踪 */
export * from './export/progress';
/** 导出主流程 */
export * from './export/export-job';

/* ------------------------------ T8-03：导入流水线 ------------------------------ */

/** 导入契约类型（ImportMode / PackageDiffPreview / ImportTargetPort …） */
export * from './import/import-types';
/** 导入前校验（版本 → 完整性 → 签名 → 解密） */
export * from './import/verifier';
/** 五种导入模式与影响预览 */
export * from './import/mode-selector';
/** 冲突分类与解决（默认不覆盖，复用 @ec/memory 合并能力） */
export * from './import/conflict-resolver';
/** 导入主流程 */
export * from './import/import-job';

/* ------------------------------ T8-04：自愈 / 增量 / 备份 ------------------------------ */

/** 自愈领域类型 */
export * from './healing/healing-types';
/** 锚点重定位（复用 @ec/ai relocate） */
export * from './healing/anchor-relocator';
/** 失效链接修复 */
export * from './healing/link-fixer';
/** 附件清点（内容寻址校验） */
export * from './healing/attachment-checker';
/** 自愈报告（JSON / Markdown 导出） */
export * from './healing/healing-report';

/** 增量导出（updatedAt 游标） */
export * from './incremental';
/** 定时备份调度（客户端内定时器 + 启动补偿） */
export * from './backup/scheduler';
/** 快照管理（生成 / 清点 / 保留份数 / 一键回滚） */
export * from './backup/snapshot-manager';
