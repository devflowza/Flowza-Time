import type { AttendanceStatus } from '@flowza/contracts';

export type Tone = 'success' | 'danger' | 'info' | 'neutral' | 'warning' | 'secondary' | 'outline';

/** Badge tone per daily-record status. */
export const STATUS_TONE: Record<AttendanceStatus, Tone> = {
  PRESENT: 'success', ABSENT: 'danger', LEAVE: 'info', HOLIDAY: 'neutral', WEEKLY_OFF: 'neutral', HALF_DAY: 'warning', MISSING_PUNCH: 'warning', NOT_JOINED: 'secondary', EXITED: 'secondary', PENDING: 'outline',
};
export const statusTone = (s: string): Tone => (STATUS_TONE as Record<string, Tone>)[s] ?? 'neutral';

/** Compact colour classes for monthly-grid cells (light + dark). Keyed by status; unknown → muted. */
export const STATUS_CELL: Record<string, string> = {
  PRESENT: 'bg-emerald-500/80 text-white dark:bg-emerald-600/80',
  ABSENT: 'bg-red-500/85 text-white dark:bg-red-600/80',
  LEAVE: 'bg-blue-500/80 text-white dark:bg-blue-600/80',
  HOLIDAY: 'bg-violet-400/70 text-white dark:bg-violet-600/70',
  WEEKLY_OFF: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200',
  HALF_DAY: 'bg-amber-400/90 text-amber-950 dark:bg-amber-500/80',
  MISSING_PUNCH: 'bg-orange-400/90 text-orange-950 dark:bg-orange-500/80',
  PENDING: 'bg-muted text-muted-foreground border border-dashed',
  NOT_JOINED: 'bg-transparent text-muted-foreground/60',
  EXITED: 'bg-transparent text-muted-foreground/60',
};
export const cellClass = (status: string | null | undefined): string => (status ? STATUS_CELL[status] ?? 'bg-muted text-muted-foreground' : 'bg-transparent');

/** Short letter shown inside a monthly cell. */
export const STATUS_LETTER: Record<string, string> = { PRESENT: 'P', ABSENT: 'A', LEAVE: 'L', HOLIDAY: 'H', WEEKLY_OFF: 'W', HALF_DAY: '½', MISSING_PUNCH: 'M', PENDING: '·', NOT_JOINED: '', EXITED: '' };

export const FLAG_TONE: Record<string, Tone> = {
  LATE: 'warning', EARLY_DEPARTURE: 'warning', OVERTIME: 'info', MISSING_IN: 'danger', MISSING_OUT: 'danger', MANUAL_CORRECTION: 'secondary', OUT_OF_WINDOW: 'neutral', WORKED_ON_HOLIDAY: 'info', WORKED_ON_WEEKLY_OFF: 'info',
  HALF_DAY_LEAVE: 'info', DUPLICATE_PUNCHES_COLLAPSED: 'neutral', RAMADAN_HOURS: 'secondary', CROSS_MIDNIGHT: 'neutral', NO_SHIFT: 'danger', UNDER_HOURS: 'warning',
};

export const CORRECTION_TONE: Record<string, Tone> = { PENDING: 'warning', APPROVED: 'info', APPLIED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' };
export const RAW_TONE: Record<string, Tone> = { pending: 'outline', normalized: 'success', unmatched: 'danger', ignored: 'neutral', error: 'danger', quarantined: 'warning', held: 'info' };
export const RAW_ROW_CLASS: Record<string, string> = { quarantined: 'bg-amber-50/70 dark:bg-amber-950/30', unmatched: 'bg-red-50/60 dark:bg-red-950/25', held: 'bg-blue-50/60 dark:bg-blue-950/25', error: 'bg-red-50/60 dark:bg-red-950/25' };
export const REQUEUEABLE = new Set(['unmatched', 'quarantined', 'held', 'error']);
export const JOB_TONE: Record<string, Tone> = { QUEUED: 'outline', RUNNING: 'info', COMPLETED: 'success', FAILED: 'danger', CANCELLED: 'neutral', EXPIRED: 'neutral' };

/** Minutes → "h:mm" (payroll style, tabular). 0 → "0:00"; null → "—". */
export function fmtHm(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
}
/** Day counts may be fractional (half days) → "12" / "12.5". */
export function fmtDays(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Month string YYYY-MM helpers. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
