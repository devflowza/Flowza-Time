import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { Badge, ErrorState } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { useHolidays } from '@/features/schedule/api';
import { daysUntil, shiftDate } from '../model';
import { ViewAllLink, WidgetCard, WidgetEmpty, WidgetRowsSkeleton } from './widget-card';

const HORIZON_DAYS = 90;

/** The next holidays (all calendars), with a countdown. A holiday already running counts as "today". */
export function HolidaysCard({ date, enabled, className, limit = 4 }: { date: string; enabled: boolean; className?: string; limit?: number }) {
  const { t, i18n } = useTranslation('dashboard');
  const q = useHolidays({ from: date, to: shiftDate(date, HORIZON_DAYS) }, enabled);
  const items = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit), [q.data, limit]);
  const countdown = (n: number) => (n <= 0 ? t('holidays.today') : n === 1 ? t('holidays.tomorrow') : t('holidays.inDays', { count: n }));
  return (
    <WidgetCard title={t('holidays.title')} icon={CalendarDays} className={className} action={<ViewAllLink to="/holidays" label={t('holidays.viewAll')} />}>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.isLoading ? <WidgetRowsSkeleton rows={3} /> : items.length === 0 ? (
        <WidgetEmpty icon={CalendarDays} title={t('holidays.empty')} hint={t('holidays.emptyHint')} />
      ) : (
        <ul className="space-y-2.5">
          {items.map((h) => {
            const days = daysUntil(date, h.date);
            const name = i18n.language === 'ar' && h.nameAr ? h.nameAr : h.name;
            return (
              <li key={h.id} className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-brand-700 dark:text-brand-300"><CalendarDays className="size-4" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{name}</span>
                  <span className="tnum block truncate text-xs text-muted-foreground">
                    {fmtDate(h.date)}{h.endDate && h.endDate !== h.date ? ` – ${fmtDate(h.endDate)}` : ''}{h.isHalfDay ? ` · ${t('holidays.halfDay')}` : ''}{h.isTentative ? ` · ${t('holidays.tentative')}` : ''}
                  </span>
                </span>
                <Badge variant={days <= 1 ? 'warning' : 'info'} className="tnum shrink-0">{countdown(days)}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}
