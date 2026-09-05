import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { fmtDate, fmtMinutes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { cellClass, STATUS_LETTER } from '../status';
import type { MonthlyDayCell, MonthlyRow } from '../types';

interface CellProps { day: string; cell: MonthlyDayCell | null; label: string; onOpen?: (recordId: string) => void }

/**
 * One day cell. Memoised so a 100 × 31 page re-renders only the cells whose data changed; the tooltip is a native `title`
 * (no per-cell portal), and the click opens the record dialog through a stable callback.
 */
const DayCell = memo(function DayCell({ day, cell, label, onOpen }: CellProps) {
  const late = !!cell?.flags.includes('LATE');
  const missing = !!cell && (cell.flags.includes('MISSING_IN') || cell.flags.includes('MISSING_OUT'));
  const ot = !!cell && cell.overtimeMinutes > 0;
  const content = (
    <span className={cn('relative flex h-7 w-7 items-center justify-center rounded text-[11px] font-semibold tnum select-none', cellClass(cell?.status))} data-status={cell?.status ?? 'none'} data-day={day}>
      {cell ? STATUS_LETTER[cell.status] ?? '?' : ''}
      {late ? <span className="absolute -top-0.5 -end-0.5 size-1.5 rounded-full bg-amber-400 ring-1 ring-card" aria-hidden /> : null}
      {missing ? <span className="absolute -bottom-0.5 -end-0.5 size-1.5 rounded-full bg-red-500 ring-1 ring-card" aria-hidden /> : null}
      {ot ? <span className="absolute -bottom-0.5 -start-0.5 size-1.5 rounded-full bg-blue-500 ring-1 ring-card" aria-hidden /> : null}
    </span>
  );
  if (!cell || !onOpen) return <td className="p-0.5 text-center" title={label}>{content}</td>;
  return (
    <td className="p-0.5 text-center">
      <button type="button" className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80" title={label} aria-label={label} onClick={() => onOpen(cell.recordId)}>{content}</button>
    </td>
  );
});

function cellLabel(t: (k: string, o?: Record<string, unknown>) => string, day: string, cell: MonthlyDayCell | null): string {
  const date = fmtDate(day, 'dd MMM');
  if (!cell) return `${date}: ${t('monthly.noRecord')}`;
  const parts = [t(`status.${cell.status}`, { defaultValue: cell.status })];
  if (cell.workedMinutes) parts.push(`${t('columns.worked')} ${fmtMinutes(cell.workedMinutes)}`);
  if (cell.lateMinutes) parts.push(`${t('columns.late')} ${fmtMinutes(cell.lateMinutes)}`);
  if (cell.overtimeMinutes) parts.push(`${t('columns.overtime')} ${fmtMinutes(cell.overtimeMinutes)}`);
  for (const f of cell.flags) if (!['LATE', 'OVERTIME'].includes(f)) parts.push(t(`flags.${f}`, { defaultValue: f }));
  return `${date}: ${parts.join(' · ')}`;
}

const GridRow = memo(function GridRow({ row, days, onOpen, onEmployee }: { row: MonthlyRow; days: string[]; onOpen?: (id: string) => void; onEmployee?: (id: string) => void }) {
  const { t } = useTranslation('attendance');
  return (
    <tr className="border-b hover:bg-muted/30">
      <th scope="row" className="sticky start-0 z-10 bg-card px-3 py-1 text-start font-normal shadow-[inset_-1px_0_0_var(--border)] rtl:shadow-[inset_1px_0_0_var(--border)]">
        {onEmployee ? <button type="button" className="block max-w-[180px] truncate text-sm font-medium hover:underline" onClick={() => onEmployee(row.employeeId)}>{row.employeeName}</button> : <span className="block max-w-[180px] truncate text-sm font-medium">{row.employeeName}</span>}
        <span className="block font-mono text-[11px] text-muted-foreground" dir="ltr">{row.employeeNumber}</span>
      </th>
      {days.map((d) => { const cell = row.days[d] ?? null; return <DayCell key={d} day={d} cell={cell} label={cellLabel(t, d, cell)} onOpen={onOpen} />; })}
      <td className="px-2 text-center text-xs tnum text-emerald-700 dark:text-emerald-300">{row.totals.present}</td>
      <td className="px-2 text-center text-xs tnum text-red-700 dark:text-red-300">{row.totals.absent}</td>
      <td className="px-2 text-center text-xs tnum text-blue-700 dark:text-blue-300">{row.totals.leave}</td>
      <td className="px-2 text-center text-xs tnum text-amber-700 dark:text-amber-300">{row.totals.late}</td>
      <td className="px-2 text-center text-xs tnum">{row.totals.missingPunch}</td>
      <td className="px-2 text-center text-xs tnum whitespace-nowrap">{fmtMinutes(row.totals.workedMinutes)}</td>
      <td className="px-2 text-center text-xs tnum whitespace-nowrap">{fmtMinutes(row.totals.overtimeMinutes)}</td>
    </tr>
  );
});

/**
 * Employees × days grid for one month page. Scrolls horizontally inside its own container (sticky employee column and
 * header); the page totals row sums the visible page. Rendering cost is O(rows × days) with memoised rows and cells.
 */
export function MonthlyGrid({ rows, days, weeklyOffDays = [], onOpenRecord, onOpenEmployee }: { rows: MonthlyRow[]; days: string[]; weeklyOffDays?: number[]; onOpenRecord?: (recordId: string) => void; onOpenEmployee?: (employeeId: string) => void }) {
  const { t } = useTranslation('attendance');
  const headers = useMemo(() => days.map((d) => { const dt = DateTime.fromISO(d); return { d, num: dt.day, dow: fmtDate(d, 'ccc'), off: weeklyOffDays.includes(dt.weekday % 7) }; }), [days, weeklyOffDays]);
  const totals = useMemo(() => rows.reduce((a, r) => ({ present: a.present + r.totals.present, absent: a.absent + r.totals.absent, leave: a.leave + r.totals.leave, late: a.late + r.totals.late, missingPunch: a.missingPunch + r.totals.missingPunch, workedMinutes: a.workedMinutes + r.totals.workedMinutes, overtimeMinutes: a.overtimeMinutes + r.totals.overtimeMinutes }), { present: 0, absent: 0, leave: 0, late: 0, missingPunch: 0, workedMinutes: 0, overtimeMinutes: 0 }), [rows]);
  return (
    <div className="relative w-full overflow-x-auto rounded-lg border bg-card shadow-card scrollbar-thin" data-testid="monthly-grid">
      <table className="w-max min-w-full border-collapse text-sm">
        <thead className="bg-muted/50">
          <tr className="border-b">
            <th scope="col" className="sticky start-0 z-20 bg-muted/50 px-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">{t('monthly.employee')}</th>
            {headers.map((h) => <th key={h.d} scope="col" className={cn('px-0.5 py-1 text-center text-[11px] font-medium leading-tight text-muted-foreground', h.off && 'text-muted-foreground/60')}><span className="block tnum">{h.num}</span><span className="block text-[9px] uppercase">{h.dow}</span></th>)}
            {(['present', 'absent', 'leave', 'late', 'missing', 'worked', 'overtime'] as const).map((k) => <th key={k} scope="col" className="px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t(`monthly.totals.${k}`)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => <GridRow key={r.employeeId} row={r} days={days} onOpen={onOpenRecord} onEmployee={onOpenEmployee} />)}
        </tbody>
        <tfoot className="border-t bg-muted/40 font-medium">
          <tr>
            <th scope="row" className="sticky start-0 z-10 bg-muted/40 px-3 py-1.5 text-start text-xs backdrop-blur">{t('monthly.pageTotals', { count: rows.length })}</th>
            <td colSpan={days.length} />
            <td className="px-2 text-center text-xs tnum">{totals.present}</td>
            <td className="px-2 text-center text-xs tnum">{totals.absent}</td>
            <td className="px-2 text-center text-xs tnum">{totals.leave}</td>
            <td className="px-2 text-center text-xs tnum">{totals.late}</td>
            <td className="px-2 text-center text-xs tnum">{totals.missingPunch}</td>
            <td className="px-2 text-center text-xs tnum whitespace-nowrap">{fmtMinutes(totals.workedMinutes)}</td>
            <td className="px-2 text-center text-xs tnum whitespace-nowrap">{fmtMinutes(totals.overtimeMinutes)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Colour legend for the grid. */
export function MonthlyLegend() {
  const { t } = useTranslation('attendance');
  const items = ['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'HALF_DAY', 'MISSING_PUNCH'];
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {items.map((s) => <span key={s} className="inline-flex items-center gap-1.5"><span className={cn('flex size-4 items-center justify-center rounded text-[9px] font-semibold', cellClass(s))}>{STATUS_LETTER[s]}</span>{t(`status.${s}`)}</span>)}
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-amber-400" />{t('flags.LATE')}</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-red-500" />{t('monthly.legendMissing')}</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-blue-500" />{t('flags.OVERTIME')}</span>
    </div>
  );
}
