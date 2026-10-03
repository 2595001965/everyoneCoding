import { useState } from 'react';
import { Button, Input } from '@ec/ui';

import { usePackageApi, type LegacyMigrationResult } from './package-api';

export function LegacyPackageMigration(): JSX.Element {
  const api = usePackageApi();
  const [packagePath, setPackagePath] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LegacyMigrationResult | null>(null);

  if (!api) return <p>外壳尚未注入旧包迁移端口。</p>;

  const pickSource = async (): Promise<void> => {
    setError(null);
    const picked = await api.pickLegacyPackagePath();
    if (picked) setPackagePath(picked);
  };
  const pickOutput = async (): Promise<void> => {
    setError(null);
    const picked = await api.pickLegacyMigrationOutputPath('ecpkg-migrated.zip');
    if (picked) setOutputPath(picked);
  };
  const migrate = async (): Promise<void> => {
    if (!packagePath || !outputPath) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.migrateLegacyPackage({
          packagePath,
          outputPath,
          ...(password.length > 0 ? { password } : {}),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="旧归档只读迁移" data-testid="legacy-package-migration">
      <h2>旧 .ecpkg 只读迁移</h2>
      <p>
        选择现有 .ecpkg 原件并另存为普通
        ZIP。迁移只读取原件；加密包需要原口令，校验或口令失败时不会创建结果文件。 ZIP
        内源码可走标准源码导入，公开数据文件放在 everyonecoding-data/ 下。
      </p>
      <div>
        <Button onClick={() => void pickSource()}>选择旧 .ecpkg</Button>
        {packagePath && <span>{packagePath}</span>}
      </div>
      <label>
        旧包口令（仅加密旧包需要）
        <Input type="password" value={password} onChange={setPassword} aria-label="旧包口令" />
      </label>
      <div>
        <Button onClick={() => void pickOutput()}>选择普通 ZIP 输出位置</Button>
        {outputPath && <span>{outputPath}</span>}
      </div>
      <Button
        variant="primary"
        disabled={busy || packagePath === null || outputPath === null}
        onClick={() => void migrate()}
      >
        {busy ? '校验并迁移中…' : '迁移为普通 ZIP'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div role="status">
          <p>
            迁移完成：源码文件 {result.sourceFiles} 个，公开数据文件 {result.publicDataFiles} 个。
          </p>
          <p>旧原件保留在：{packagePath}</p>
          <p>标准 ZIP：{result.outputPath}</p>
          {result.projects.length > 0 ? (
            <ul aria-label="源码识别结果">
              {result.projects.map((project, index) => (
                <li key={`${project.name}-${index}`}>
                  {project.name}：{project.framework ?? '未识别'} / {project.support}
                </li>
              ))}
            </ul>
          ) : (
            <p>未从旧包识别出源码工程；公开数据仍已迁出，源码 ZIP 可在标准源码导入中检查。</p>
          )}
        </div>
      )}
    </section>
  );
}
