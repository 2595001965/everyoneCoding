import { useAppStore } from '../store/useAppStore';
import { useT } from '../i18n';

/** 底部状态栏：外壳形态、就绪状态、降级能力提示 */
export function StatusBar(): JSX.Element {
  const t = useT();
  const shellKind = useAppStore((state) => state.shellKind);
  const shellReady = useAppStore((state) => state.shellReady);
  const degraded = useAppStore((state) => state.degraded);

  return (
    <footer className="ec-statusbar" role="status">
      <span>
        {t('status.shell')}: {shellKind}
      </span>
      <span>{shellReady ? t('status.ready') : '…'}</span>
      {degraded.length > 0 ? (
        <span className="ec-statusbar__degraded">降级: {degraded.join(', ')}</span>
      ) : null}
    </footer>
  );
}
