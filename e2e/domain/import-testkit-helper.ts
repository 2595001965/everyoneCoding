/**
 * e2e 内用的 package-kit 测试夹具桥。
 *
 * import-testkit.ts 位于 packages/package-kit/src/__tests__/（不在包出口里），
 * e2e 无法通过 `@ec/package-kit` 拿到。这里用相对路径直接引它 —— 与
 * e2e/vitest.config.ts 的 alias 策略不冲突（vitest 按文件路径解析）。
 */

export {
  makeMemoryItem,
  makeTargetPort,
  makeLocalPort,
  buildPackage,
  type PackageSpec,
} from '../../packages/package-kit/src/__tests__/import-testkit';
