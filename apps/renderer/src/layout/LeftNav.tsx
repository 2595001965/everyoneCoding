import { NavLink } from 'react-router-dom';
import { useT } from '../i18n';
import { AppIcon } from './AppIcon';
import { navigation, utilityNavigation } from './navigation';

export function LeftNav(): JSX.Element {
  const t = useT();
  const renderItem = (item: (typeof navigation)[number] | (typeof utilityNavigation)[number]) => (
    <li key={item.to}>
      <NavLink
        to={item.to}
        end={item.to === '/'}
        title={t(item.label)}
        className={({ isActive }) =>
          `ec-leftnav__item${isActive ? ' ec-leftnav__item--active' : ''}`
        }
      >
        <AppIcon name={item.icon} />
        <span className="ec-leftnav__label">{t(item.label)}</span>
      </NavLink>
    </li>
  );
  return (
    <nav aria-label={t('nav.main')} className="ec-leftnav">
      <div className="ec-leftnav__workspace">
        <span className="ec-leftnav__avatar">E</span>
        <div>
          <strong>{t('nav.personal')}</strong>
          <small>EveryoneCoding</small>
        </div>
      </div>
      {(['build', 'manage'] as const).map((group) => (
        <div className="ec-leftnav__group" key={group}>
          <p className="ec-leftnav__heading">{t(group === 'build' ? 'nav.build' : 'nav.manage')}</p>
          <ul className="ec-leftnav__list">
            {navigation.filter((item) => item.group === group).map(renderItem)}
          </ul>
        </div>
      ))}
      <div className="ec-leftnav__bottom">
        <ul className="ec-leftnav__list">{utilityNavigation.map(renderItem)}</ul>
        <p className="ec-leftnav__footnote">{t('nav.local')}</p>
      </div>
    </nav>
  );
}
