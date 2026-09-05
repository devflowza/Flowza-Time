import { NavLink, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/layout/page-header';
import { cn } from '@/lib/utils';
import { SETTINGS_NAV } from '../nav';

export default function SettingsLayout() {
  const { t } = useTranslation('settings');
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label={t('title')} className="-mx-1 flex gap-1 overflow-x-auto pb-1 lg:mx-0 lg:flex-col lg:overflow-visible">
          {SETTINGS_NAV.map(({ key, icon: Icon }) => (
            <NavLink key={key} to={`/settings/${key}`} className={({ isActive }) => cn('flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent', isActive && 'bg-accent font-medium text-brand-800 dark:text-brand-200')}>
              <Icon className="size-4" aria-hidden /> {t(`nav.${key}`)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 space-y-5"><Outlet /></div>
      </div>
    </div>
  );
}
