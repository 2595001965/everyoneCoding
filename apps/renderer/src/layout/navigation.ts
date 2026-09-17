import type { MessageKey } from '../i18n';
import type { AppIconName } from './AppIcon';

export const navigation: Array<{
  to: string;
  label: MessageKey;
  icon: AppIconName;
  group: 'build' | 'manage';
}> = [
  { to: '/', label: 'nav.workspace', icon: 'workspace', group: 'build' },
  { to: '/designer', label: 'nav.designer', icon: 'designer', group: 'build' },
  { to: '/pipeline', label: 'nav.pipeline', icon: 'pipeline', group: 'build' },
  { to: '/preview', label: 'nav.preview', icon: 'preview', group: 'build' },
  { to: '/memory', label: 'nav.memory', icon: 'memory', group: 'manage' },
  { to: '/docs', label: 'nav.docs', icon: 'docs', group: 'manage' },
  { to: '/git', label: 'nav.git', icon: 'git', group: 'manage' },
  { to: '/rename', label: 'nav.rename', icon: 'rename', group: 'manage' },
  { to: '/usage', label: 'nav.usage', icon: 'usage', group: 'manage' },
];

export const utilityNavigation = [
  { to: '/account', label: 'nav.account', icon: 'account' },
  { to: '/settings', label: 'nav.settings', icon: 'settings' },
] as const;
