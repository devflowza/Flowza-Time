import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, ListChecks, Wallet } from 'lucide-react';
import { LanguageSwitcher } from '@/components/layout/language-switcher';

/**
 * The signed-out frame: the product's colour as light on a dark panel (globals.css .auth-hero / .auth-grid) beside a
 * quiet form column. Colours are sidebar tokens — the shell clears the tenant style on sign-out, so this is always the
 * FlowZa default — and the panel only appears from `lg`, where there is room for it.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const points = [
    { icon: Cpu, text: t('app.heroPoints.devices') },
    { icon: ListChecks, text: t('app.heroPoints.rules') },
    { icon: Wallet, text: t('app.heroPoints.payroll') },
  ];
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <div className="auth-hero relative hidden overflow-hidden text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div aria-hidden className="auth-grid pointer-events-none absolute inset-0" />
        <div className="relative flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9 rounded-xl shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_8px_24px_rgb(0_0_0/0.35)]" />
          <span className="text-lg font-semibold tracking-tight text-sidebar-strong">{t('app.name')}</span>
        </div>
        <div className="relative max-w-lg space-y-6">
          <h2 className="text-4xl font-semibold leading-[1.1] text-sidebar-strong xl:text-[44px]">{t('app.tagline')}</h2>
          <p className="max-w-md text-pretty text-[15px] leading-relaxed text-sidebar-foreground/85">{t('app.heroBody')}</p>
          <ul className="space-y-3 pt-2">
            {points.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-sidebar-foreground/90">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-hover text-sidebar-active-icon ring-1 ring-inset ring-sidebar-border"><Icon className="size-4" aria-hidden /></span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-sidebar-foreground/70">© F &amp; Z Capital</p>
      </div>
      <div className="flex flex-col">
        <div className="flex justify-end p-4"><LanguageSwitcher /></div>
        <div className="flex flex-1 items-center justify-center px-6 pb-16 pt-4 [&>*]:animate-page-in">{children}</div>
      </div>
    </div>
  );
}
