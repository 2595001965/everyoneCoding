import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CommandPalette } from '@ec/ui';
import { useT } from '../i18n';
import { useUiStore } from '../store/useUiStore';
import { AppIcon } from './AppIcon';
import { navigation, utilityNavigation } from './navigation';

export function TitleBar(): JSX.Element {
  const t = useT();
  const [commandsOpen, setCommandsOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const rightPanelOpen = useUiStore((state) => state.rightPanelOpen);
  const toggleRightPanel = useUiStore((state) => state.toggleRightPanel);
  const items = [...navigation, ...utilityNavigation];
  const current = items.find((item) => item.to === pathname);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'k' &&
        !event.isComposing
      ) {
        event.preventDefault();
        setCommandsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <header className="ec-titlebar">
      <span className="ec-titlebar__brand">
        <span className="ec-titlebar__mark">
          e<span>c</span>
        </span>
        <span className="ec-titlebar__title">{t('app.title')}</span>
      </span>
      <span className="ec-titlebar__breadcrumb">
        {current ? t(current.label) : t('app.subtitle')}
      </span>
      <button
        type="button"
        className="ec-titlebar__search"
        onClick={() => setCommandsOpen(true)}
        aria-label={t('nav.quick')}
      >
        <AppIcon name="search" size={15} />
        <span>{t('nav.quick')}</span>
        <kbd>Ctrl K</kbd>
      </button>
      <button
        type="button"
        className="ec-titlebar__action"
        aria-label={t('theme.switch')}
        title={`${t('theme.current')}: ${t(`theme.${theme}`)}`}
        onClick={() => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light')}
      >
        <AppIcon name={theme === 'dark' ? 'moon' : theme === 'system' ? 'preview' : 'sun'} />
      </button>
      {pathname !== '/designer' && (
        <button
          type="button"
          className="ec-titlebar__action"
          aria-label={t('panel.toggle')}
          data-guide-toggle=""
          aria-pressed={rightPanelOpen}
          onClick={toggleRightPanel}
        >
          <AppIcon name="panel" />
        </button>
      )}
      {commandsOpen && (
        <CommandPalette
          open
          onOpenChange={setCommandsOpen}
          placeholder={t('nav.search')}
          commands={items.map((item) => ({
            id: item.to,
            title: t(item.label),
            keywords: [item.icon],
            icon: <AppIcon name={item.icon} />,
          }))}
          onSelect={(id) => navigate(id)}
        />
      )}
    </header>
  );
}
