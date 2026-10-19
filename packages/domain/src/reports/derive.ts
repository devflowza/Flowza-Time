import { minutesBetweenInstants } from './format.js';

export interface HoursInput {
  status: string;
  flags: readonly string[];
  firstInAt: string | Date | null;
  lastOutAt: string | Date | null;
  workedMinutes: number;
  scheduledMinutes: number;
  overtimeMinutes: number;
  overtimeCategory: string | null;
}

/**
 * The hour columns of the Daily and Detail reports, derived from one daily record. `null` means the column is not
 * applicable to this kind of day (an absence has no base hours) and renders as a dash.
 *
 * - `span`  — Wrk Hrs: raw IN → OUT span, no deductions.
 * - `worked` — Tot Hrs: the engine's worked minutes (span minus unpaid breaks, after the tenant's rounding rules).
 * - `scheduled` — Base Hrs.
 * - `ot1` — REGULAR overtime; `ot2` — overtime worked on a weekly off or holiday (the premium-rate bucket).
 * - `ut` — under time: Base − Tot when the day was worked short. A day with a single punch (nothing measurable)
 *   is short by the whole base, which is how the samples print it.
 */
export interface DerivedHours { span: number | null; worked: number | null; scheduled: number | null; ot1: number | null; ot2: number | null; ut: number | null }

const WORKED_STATUSES = new Set(['PRESENT', 'HALF_DAY', 'MISSING_PUNCH']);

export function isWorkedDay(r: Pick<HoursInput, 'status' | 'flags' | 'workedMinutes'>): boolean {
  if (WORKED_STATUSES.has(r.status)) return true;
  if ((r.status === 'WEEKLY_OFF' || r.status === 'HOLIDAY') && (r.flags.includes('WORKED_ON_WEEKLY_OFF') || r.flags.includes('WORKED_ON_HOLIDAY'))) return true;
  return r.status === 'LEAVE' && r.workedMinutes > 0;
}

export function deriveHours(r: HoursInput): DerivedHours {
  if (!isWorkedDay(r)) return { span: null, worked: null, scheduled: null, ot1: null, ot2: null, ut: null };
  const span = minutesBetweenInstants(r.firstInAt, r.lastOutAt);
  const premium = r.overtimeCategory === 'WEEKLY_OFF' || r.overtimeCategory === 'HOLIDAY';
  const overtime = Math.max(0, r.overtimeMinutes);
  const scheduled = Math.max(0, r.scheduledMinutes);
  const worked = Math.max(0, r.workedMinutes);
  return {
    span,
    worked,
    scheduled,
    ot1: premium ? 0 : overtime,
    ot2: premium ? overtime : 0,
    ut: scheduled > 0 ? Math.max(0, scheduled - worked) : 0,
  };
}

export type ShiftHoursVerdict = 'MET' | 'SHORT' | 'MISSED_PUNCH';

/**
 * Whether a worked day reached its shift's hours (Monthly Timesheet's "Hours Met"): `MET` when Tot Hrs ≥ Base Hrs, `SHORT`
 * when not (the gap is the day's UT), `MISSED_PUNCH` when a check-in or check-out is missing so the hours cannot be judged.
 * `null` when there is nothing to judge: a day not worked (absence, leave, weekly off, holiday — its code says so) or a worked
 * day that required no hours (work on a weekly off or holiday, or without a shift — all of it is overtime).
 */
export function shiftHoursVerdict(r: HoursInput): ShiftHoursVerdict | null {
  const h = deriveHours(r);
  if (h.worked === null || h.scheduled === null) return null;
  if (r.status === 'MISSING_PUNCH') return 'MISSED_PUNCH';
  if (h.scheduled === 0) return null;
  return h.worked >= h.scheduled ? 'MET' : 'SHORT';
}

export interface TracePunchLike { punchedAt?: string; role?: string }
export interface PunchPair { inAt: string | null; outAt: string | null }

/**
 * IN/OUT pairs from a record's calculation trace, in time order. Under PAIRED interpretation this yields one pair per
 * visit (and lone punches as half-pairs), which is how the Daily and Missed Punch samples print several rows for one
 * employee; under FIRST_LAST the trace carries exactly one IN and one OUT role, so exactly one pair comes back.
 */
export function pairPunches(punches: readonly TracePunchLike[]): PunchPair[] {
  const ordered = punches.filter((p) => (p.role === 'IN' || p.role === 'OUT') && typeof p.punchedAt === 'string').sort((a, b) => a.punchedAt!.localeCompare(b.punchedAt!));
  const pairs: PunchPair[] = [];
  let open: PunchPair | null = null;
  for (const p of ordered) {
    if (p.role === 'IN') {
      if (open) pairs.push(open);
      open = { inAt: p.punchedAt!, outAt: null };
    } else if (open) {
      open.outAt = p.punchedAt!;
      pairs.push(open);
      open = null;
    } else {
      pairs.push({ inAt: null, outAt: p.punchedAt! });
    }
  }
  if (open) pairs.push(open);
  return pairs;
}

/**
 * Shortfall ("Short", the reports' UT): base − worked minutes when a worked day fell short of its shift's hours, 0 on every other
 * day (absence, leave, weekly off, holiday, a day not judged yet). The ONE rule the daily register, the record dialog, the portal,
 * the dashboard and the reports use, so the figure cannot drift between them. A missing-punch day is short by its whole base until
 * the punch is corrected, exactly as the Daily Report prints it.
 */
export function shortfallMinutes(r: HoursInput): number {
  return deriveHours(r).ut ?? 0;
}

/**
 * What makes an employee-day irregular (the "Irregular cases" report and its schedules): a late arrival, an early departure, an
 * absence, a missing check-in / check-out, short hours (the engine's UNDER_HOURS, or a present day short of its base) or a day
 * marked unexcused. In this order — the order the report prints them.
 */
export const IRREGULARITY_KINDS = ['LATE', 'EARLY_DEPARTURE', 'ABSENT', 'MISSING_IN', 'MISSING_OUT', 'UNDER_HOURS', 'UNEXCUSED'] as const;
export type IrregularityKind = (typeof IRREGULARITY_KINDS)[number];

/** Statuses the engine has not judged (or that are outside employment): never irregular. */
const NOT_JUDGED = new Set(['PENDING', 'NOT_JOINED', 'EXITED']);

export function irregularitiesOf(r: HoursInput): IrregularityKind[] {
  if (NOT_JUDGED.has(r.status)) return [];
  const out: IrregularityKind[] = [];
  if (r.flags.includes('LATE') || r.flags.includes('VERY_LATE')) out.push('LATE');
  if (r.flags.includes('EARLY_DEPARTURE')) out.push('EARLY_DEPARTURE');
  if (r.status === 'ABSENT') out.push('ABSENT');
  const missingIn = r.flags.includes('MISSING_IN');
  const missingOut = r.flags.includes('MISSING_OUT');
  if (missingIn) out.push('MISSING_IN');
  if (missingOut) out.push('MISSING_OUT');
  // a day with a missing punch has unknown hours: it is the missing punch, not short hours, until the punch is corrected
  if (r.flags.includes('UNDER_HOURS') || (r.status === 'PRESENT' && !missingIn && !missingOut && shortfallMinutes(r) > 0)) out.push('UNDER_HOURS');
  if (r.flags.includes('UNEXCUSED')) out.push('UNEXCUSED');
  return out;
}
