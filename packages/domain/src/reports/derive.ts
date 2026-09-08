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
