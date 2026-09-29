import { Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** "FlowZa Time · Admin Portal" wordmark. `tone="dark"` sits on the portal's fixed dark sidebar, `light` on the page background. */
export function AdmBrand({ className, tone = 'dark', compact = false }: { className?: string; tone?: 'dark' | 'light'; compact?: boolean }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-white shadow-sm"><Shield className="size-[18px]" aria-hidden /></div>
      {compact ? null : (
        <div className="min-w-0">
          <div className={cn('truncate text-sm font-semibold', tone === 'dark' ? 'text-white' : 'text-foreground')}>{tc('app.name')}</div>
          <div className={cn('truncate text-[11px] font-medium uppercase tracking-wider', tone === 'dark' ? 'text-amber-400/90' : 'text-amber-600 dark:text-amber-400')}>{t('portal')}</div>
        </div>
      )}
    </div>
  );
}
