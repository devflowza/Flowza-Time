import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '@/components/layout/language-switcher';

export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden bg-sidebar text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9 rounded-lg" />
          <span className="text-lg font-semibold text-white">{t('app.name')}</span>
        </div>
        <div className="max-w-md space-y-4">
          <h2 className="text-3xl font-semibold leading-tight text-white">{t('app.tagline')}</h2>
          <p className="text-sm text-sidebar-foreground/80">Multi-branch attendance, device synchronisation and payroll-ready summaries — built for the GCC.</p>
        </div>
        <p className="text-xs text-sidebar-foreground/60">© F &amp; Z Capital</p>
      </div>
      <div className="flex flex-col">
        <div className="flex justify-end p-4"><LanguageSwitcher /></div>
        <div className="flex flex-1 items-center justify-center p-6">{children}</div>
      </div>
    </div>
  );
}
