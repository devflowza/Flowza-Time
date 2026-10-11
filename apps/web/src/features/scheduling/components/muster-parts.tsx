import { useTranslation } from 'react-i18next';
import { Coffee, Eye, LogOut, UserCheck, type LucideIcon } from 'lucide-react';
import { MUSTER_STATES, type LocationMusterEntryDto, type MusterState, type MusterTotals } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtNumber, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SCHED_NS } from '../i18n';
import { MUSTER_TONE, musterTotal } from '../muster';

const ICONS: Record<MusterState, LucideIcon> = { on_site: UserCheck, on_break: Coffee, left: LogOut, seen: Eye };

/** A muster state as a badge: the label in the text colour, the state in the tenant palette's dot. */
export function MusterStateBadge({ state }: { state: MusterState }) {
  const { t } = useTranslation(SCHED_NS);
  return <Badge variant="outline" data-testid="muster-state"><span className={cn('size-2 rounded-full', MUSTER_TONE[state].dot)} aria-hidden />{t(`muster.states.${state}`)}</Badge>;
}

/**
 * One state's total as a tile — the count, its share of everyone seen, the chart token of the state. Pressing it filters the
 * list to that state (pressed again: everyone).
 */
export function MusterStatTile({ state, totals, active, onToggle }: { state: MusterState; totals: MusterTotals; active: boolean; onToggle: () => void }) {
  const { t } = useTranslation(SCHED_NS);
  const Icon = ICONS[state];
  const all = musterTotal(totals);
  const count = totals[state] ?? 0;
  const share = all > 0 ? Math.round((count / all) * 100) : 0;
  return (
    <button type="button" aria-pressed={active} onClick={onToggle} data-testid={`muster-total-${state}`}
      className={cn('flex min-w-0 flex-col rounded-lg border bg-card p-4 text-start text-card-foreground shadow-card transition-colors hover:border-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'border-brand-500 ring-1 ring-brand-500')}>
      <span className="flex items-start gap-3">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', MUSTER_TONE[state].chip)}><Icon className="size-5" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-muted-foreground">{t(`muster.states.${state}`)}</span>
          <span className="block text-2xl font-semibold leading-tight tnum">{fmtNumber(count)}</span>
        </span>
      </span>
      <span className="mt-2 block truncate text-xs text-muted-foreground">{t(`muster.stateHints.${state}`)}</span>
      <span className="mt-auto block pt-3">
        <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className={cn('block h-full rounded-full', MUSTER_TONE[state].bar)} style={{ width: `${share}%` }} />
        </span>
      </span>
    </button>
  );
}

/**
 * The roll-call sheet (printed from the muster page, report.export): who was seen in the location on the day, on site first,
 * with an empty box per person to tick off at the assembly point and lines for the warden.
 */
export function MusterRollCall({ orgName, locationLabel, date, generatedAt, timezone, totals, entries, entryTimezone }: {
  orgName: string; locationLabel: string; date: string; generatedAt: string; timezone: string; totals: MusterTotals;
  /** Already in roll-call order. */
  entries: readonly LocationMusterEntryDto[];
  entryTimezone: (e: LocationMusterEntryDto) => string;
}) {
  const { t } = useTranslation(SCHED_NS);
  return (
    <article className="hidden space-y-3 text-sm print:block" data-testid="muster-roll-call">
      <header className="flex items-start justify-between gap-3 border-b pb-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{orgName}</p>
          <h1 className="text-lg font-semibold">{t('muster.rollCall.title')}</h1>
          <p>{locationLabel} · {fmtDate(date)}</p>
        </div>
        <p className="text-end text-xs text-muted-foreground">{t('muster.rollCall.generated', { at: fmtDateTime(generatedAt, timezone) })}</p>
      </header>
      <p className="text-xs">{MUSTER_STATES.map((s) => `${t(`muster.states.${s}`)}: ${totals[s] ?? 0}`).join(' · ')}</p>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="py-1 pe-2 text-start font-medium">#</th>
            <th className="py-1 pe-2 text-start font-medium">{t('muster.columns.employee')}</th>
            <th className="py-1 pe-2 text-start font-medium">{t('muster.columns.number')}</th>
            <th className="py-1 pe-2 text-start font-medium">{t('muster.columns.state')}</th>
            <th className="py-1 pe-2 text-start font-medium">{t('muster.columns.time')}</th>
            <th className="py-1 pe-2 text-start font-medium">{t('muster.columns.place')}</th>
            <th className="py-1 text-center font-medium">{t('muster.rollCall.accounted')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={e.employeeId} className="break-inside-avoid border-b last:border-0">
              <td className="py-1 pe-2 tnum">{i + 1}</td>
              <td className="py-1 pe-2">{e.displayName}</td>
              <td className="py-1 pe-2 font-mono" dir="ltr">{e.employeeNumber}</td>
              <td className="py-1 pe-2">{t(`muster.states.${e.state}`)}</td>
              <td className="py-1 pe-2 tnum" dir="ltr">{fmtTime(e.punchedAt, entryTimezone(e))}</td>
              <td className="py-1 pe-2">{e.locationName}</td>
              <td className="py-1 text-center"><span className="inline-block size-3.5 border border-foreground/60" aria-hidden /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-cols-2 gap-8 pt-6 text-xs">
        <p className="border-t pt-1">{t('muster.rollCall.checkedBy')}</p>
        <p className="border-t pt-1">{t('muster.rollCall.signature')}</p>
      </div>
    </article>
  );
}
