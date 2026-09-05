import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Accessible day-of-week toggle group (0 = Sunday … 6 = Saturday, matching `weeklyOffDaysSchema`). */
export function WeeklyOffToggles({ value, onChange, disabled, ariaLabel }: { value: number[] | null | undefined; onChange: (days: number[]) => void; disabled?: boolean; ariaLabel: string }) {
  const { t } = useTranslation('organization');
  const set = new Set(value ?? []);
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {DAYS.map((d) => {
        const on = set.has(d);
        return (
          <button key={d} type="button" role="checkbox" aria-checked={on} disabled={disabled} onClick={() => { const next = new Set(set); if (on) next.delete(d); else next.add(d); onChange([...next].sort()); }}
            className={cn('h-8 min-w-11 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent')}>
            {t(`days.${d}`)}
          </button>
        );
      })}
    </div>
  );
}
