import { DateTime } from 'luxon';
import { chargedLeaveDates, leaveDaysInWindow, type LeaveCountMode, type StoredLeaveRange, type WorkingCalendar } from './days.js';

/**
 * Leave balances — THE one source of truth (HR portal Prompt 7, Finance parity A10 / B-42). Pure: every screen, the API
 * (portal, HR balances, apply warnings, approval context), the unexcused-day charger and the year-close job read balances
 * through `computeLeaveBalances`; nothing is ever stored as a counter.
 *
 *   entitlement = allocation row (allocated + counted carry-forward + opening + adjustment), or — without a row — the
 *                 type's `annual_allowance_days`, prorated from the joining date in the joining year;
 *   taken       = APPROVED leave days in the year (`leaveDaysInWindow`, leave v2 review P1-2): a leave inside the year
 *                 charges its stored `days` — the value at submission, so a later transfer or calendar change never moves
 *                 history; a leave without stored days, or one crossing the year boundary (clipped to the year), is
 *                 counted by the type's count mode through the per-date working calendar;
 *   pending     = PENDING + INFO_REQUESTED days in the year (same rule);
 *   accrued     = monthly accrual only: the allocation (or prorated allowance) spread evenly over the service months of
 *                 the year, earned in proportion to the days elapsed up to `asOf`, floored to half days, plus the counted
 *                 carry-forward, the opening balance and the adjustment (they are available at once);
 *   available   = (accrual ? accrued : entitlement) − taken;   availableAfterPending = available − pending.
 *
 * Carry-forward expires on `carriedForwardExpiresOn`: before that date it counts in full; after it, only the part the
 * employee actually used before the expiry stays (leave taken up to the expiry is charged to the carried-forward days
 * first), the rest is reported as `carriedForwardExpiredDays`.
 *
 * The comp-off type (system key COMP_OFF) is balanced from credits, not allocations: entitlement = days earned on
 * approved, unexpired credits; taken = what those credits already paid for; available = the difference.
 */

export type LeaveAccrual = 'none' | 'monthly';

export interface BalanceTypeInput {
  leaveTypeId: string;
  /** The type's yearly default (null = not tracked unless an allocation row exists). */
  annualAllowanceDays: number | null;
  countMode: LeaveCountMode;
  accrual: LeaveAccrual;
  /** The organisation's comp-off type: balanced from `credits`. */
  compOff?: boolean;
}

export interface BalanceAllocationInput {
  leaveTypeId: string;
  allocatedDays: number;
  carriedForwardDays: number;
  carriedForwardExpiresOn: string | null;
  openingBalanceDays: number;
  adjustmentDays: number;
}

/** A leave of the employee: its range, type, status and — when stored — its `days` (the value at submission). */
export interface BalanceRecordInput extends StoredLeaveRange { leaveTypeId: string; status: string }

export interface BalanceCreditInput { status: string; daysEarned: number; usedDays: number; expiresOn: string | null }

export interface ComputeBalancesInput {
  year: number;
  /** "Today" for accrual and carry-forward expiry; clamped into the year. */
  asOf: string;
  /** The employee's joining date (proration of the joining year); null = employed all year. */
  joiningDate: string | null;
  types: readonly BalanceTypeInput[];
  /** Allocation rows of `year` (other years are ignored). */
  allocations: ReadonlyArray<BalanceAllocationInput & { year?: number }>;
  /** Leave of the employee overlapping the year, any status (only APPROVED / PENDING / INFO_REQUESTED count). */
  records: readonly BalanceRecordInput[];
  /** Comp-off credits of the employee (any status; only approved / partially_used / used unexpired ones count). */
  credits?: readonly BalanceCreditInput[];
  calendar: WorkingCalendar;
}

export interface LeaveBalance {
  leaveTypeId: string;
  /** An entitlement exists (allocation row, type allowance, or the comp-off type). */
  tracked: boolean;
  hasAllocation: boolean;
  /** Allocated days of the row, else the (prorated) type allowance; null when untracked or comp-off. */
  allocatedDays: number | null;
  /** Carried-forward days that still count (unexpired, or used before the expiry). */
  carriedForwardDays: number;
  carriedForwardExpiresOn: string | null;
  carriedForwardExpiredDays: number;
  openingBalanceDays: number;
  adjustmentDays: number;
  entitlementDays: number | null;
  takenDays: number;
  pendingDays: number;
  /** Monthly accrual only (else null). */
  accruedToDateDays: number | null;
  availableDays: number | null;
  availableAfterPendingDays: number | null;
}

const PENDING_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'INFO_REQUESTED']);
const CREDIT_COUNTED: ReadonlySet<string> = new Set(['approved', 'partially_used', 'used']);

/** Round to the nearest half day (removes float noise; every leave figure is a multiple of 0.5). */
export const roundHalf = (n: number): number => Math.round(n * 2) / 2;
/** Floor to half days (accrual: never promise a half day that is not yet earned). */
export const floorHalf = (n: number): number => Math.floor(n * 2 + 1e-9) / 2;

const iso = (d: DateTime): string => d.toISODate()!;
const parse = (s: string): DateTime => DateTime.fromISO(s, { zone: 'utc' });

/**
 * Months covered by the inclusive date range [from, to], each calendar month counting in proportion to its days inside
 * the range (a full year = 12, 15 Jan–31 Jan ≈ 0.548). 0 when to < from.
 */
export function monthsInRange(from: string, to: string): number {
  if (to < from) return 0;
  let total = 0;
  let cursor = parse(from).startOf('month');
  const end = parse(to);
  const start = parse(from);
  while (cursor <= end) {
    const monthStart = cursor; const monthEnd = cursor.endOf('month').startOf('day');
    const a = start > monthStart ? start : monthStart;
    const b = end < monthEnd ? end : monthEnd;
    const days = Math.round(b.diff(a, 'days').days) + 1;
    if (days > 0) total += days / monthEnd.day;
    cursor = cursor.plus({ months: 1 });
  }
  return total;
}

/** The part of `year` the employee is employed from (the joining date in the joining year, else 1 Jan); null = not employed that year. */
export function serviceStartInYear(year: number, joiningDate: string | null): string | null {
  const yearStart = `${year}-01-01`; const yearEnd = `${year}-12-31`;
  if (!joiningDate || joiningDate <= yearStart) return yearStart;
  return joiningDate <= yearEnd ? joiningDate : null;
}

/** A yearly allowance prorated for a joiner (service months of the year / 12), rounded to half days; the full allowance for anyone employed on 1 Jan. */
export function prorateAllowance(allowanceDays: number, year: number, joiningDate: string | null): number {
  const start = serviceStartInYear(year, joiningDate);
  if (start === null) return 0;
  if (start === `${year}-01-01`) return allowanceDays;
  return roundHalf((allowanceDays * monthsInRange(start, `${year}-12-31`)) / 12);
}

/**
 * Accrued to date for a monthly-accrual base: the base spread evenly over the service months of the year, earned in
 * proportion to the service months elapsed up to `asOf` (inclusive), floored to half days.
 */
export function accruedToDate(baseDays: number, year: number, joiningDate: string | null, asOf: string): number {
  const start = serviceStartInYear(year, joiningDate);
  if (start === null || baseDays <= 0) return 0;
  const yearEnd = `${year}-12-31`;
  const service = monthsInRange(start, yearEnd);
  if (service <= 0) return 0;
  const until = asOf > yearEnd ? yearEnd : asOf;
  const elapsed = monthsInRange(start, until);
  if (elapsed >= service) return baseDays;
  return floorHalf((baseDays * elapsed) / service);
}

/** Days carried into the next year: the available balance floored to half days, capped at the type's maximum (0 = none). */
export function carryForwardDays(availableDays: number | null, maxDays: number): number {
  if (availableDays === null || maxDays <= 0 || availableDays <= 0) return 0;
  return Math.min(maxDays, floorHalf(availableDays));
}

/** Expiry of days carried into `toYear`: the last day of the `months`-th month of that year (null = never). */
export function carryForwardExpiry(toYear: number, months: number | null): string | null {
  if (months === null || months <= 0) return null;
  return iso(DateTime.fromObject({ year: toYear, month: 1, day: 1 }, { zone: 'utc' }).plus({ months }).minus({ days: 1 }));
}

/** asOf clamped into [1 Jan, 31 Dec] of the year. */
export function clampToYear(asOf: string, year: number): string {
  const from = `${year}-01-01`; const to = `${year}-12-31`;
  return asOf < from ? from : asOf > to ? to : asOf;
}

export function computeLeaveBalances(input: ComputeBalancesInput): LeaveBalance[] {
  const { year, calendar } = input;
  const clip = { from: `${year}-01-01`, to: `${year}-12-31` };
  const asOf = clampToYear(input.asOf, year);
  const allocationByType = new Map(input.allocations.filter((a) => a.year === undefined || a.year === year).map((a) => [a.leaveTypeId, a]));
  return input.types.map((t): LeaveBalance => {
    const own = input.records.filter((r) => r.leaveTypeId === t.leaveTypeId);
    const count = (r: BalanceRecordInput, until?: string) => leaveDaysInWindow(r, calendar, t.countMode, until ? { from: clip.from, to: until < clip.to ? until : clip.to } : clip);
    let taken = 0; let pending = 0;
    for (const r of own) {
      if (r.status === 'APPROVED') taken += count(r);
      else if (PENDING_STATUSES.has(r.status)) pending += count(r);
    }
    taken = roundHalf(taken); pending = roundHalf(pending);

    if (t.compOff) {
      const counted = (input.credits ?? []).filter((c) => CREDIT_COUNTED.has(c.status) && c.expiresOn !== null && c.expiresOn >= input.asOf);
      const earned = roundHalf(counted.reduce((a, c) => a + c.daysEarned, 0));
      const used = roundHalf(counted.reduce((a, c) => a + c.usedDays, 0));
      const available = roundHalf(earned - used);
      return {
        leaveTypeId: t.leaveTypeId, tracked: true, hasAllocation: false, allocatedDays: null, carriedForwardDays: 0, carriedForwardExpiresOn: null, carriedForwardExpiredDays: 0,
        openingBalanceDays: 0, adjustmentDays: 0, entitlementDays: earned, takenDays: used, pendingDays: pending, accruedToDateDays: null,
        availableDays: available, availableAfterPendingDays: roundHalf(available - pending),
      };
    }

    const row = allocationByType.get(t.leaveTypeId);
    const base = row ? row.allocatedDays : t.annualAllowanceDays === null ? null : prorateAllowance(t.annualAllowanceDays, year, input.joiningDate);
    if (base === null) {
      return {
        leaveTypeId: t.leaveTypeId, tracked: false, hasAllocation: false, allocatedDays: null, carriedForwardDays: 0, carriedForwardExpiresOn: null, carriedForwardExpiredDays: 0,
        openingBalanceDays: 0, adjustmentDays: 0, entitlementDays: null, takenDays: taken, pendingDays: pending, accruedToDateDays: null, availableDays: null, availableAfterPendingDays: null,
      };
    }
    // carry-forward: counted in full until it expires; afterwards only what was used before the expiry (used first)
    const cf = row?.carriedForwardDays ?? 0;
    const cfExpires = row?.carriedForwardExpiresOn ?? null;
    let cfCounted = cf;
    if (cf > 0 && cfExpires !== null && asOf > cfExpires) {
      const takenBeforeExpiry = roundHalf(own.filter((r) => r.status === 'APPROVED').reduce((a, r) => a + count(r, cfExpires), 0));
      cfCounted = Math.min(cf, takenBeforeExpiry);
    }
    const opening = row?.openingBalanceDays ?? 0;
    const adjustment = row?.adjustmentDays ?? 0;
    const entitlement = roundHalf(base + cfCounted + opening + adjustment);
    const accrued = t.accrual === 'monthly' ? roundHalf(accruedToDate(base, year, input.joiningDate, asOf) + cfCounted + opening + adjustment) : null;
    const available = roundHalf((accrued ?? entitlement) - taken);
    return {
      leaveTypeId: t.leaveTypeId, tracked: true, hasAllocation: !!row, allocatedDays: base, carriedForwardDays: cfCounted, carriedForwardExpiresOn: cfExpires, carriedForwardExpiredDays: roundHalf(cf - cfCounted),
      openingBalanceDays: opening, adjustmentDays: adjustment, entitlementDays: entitlement, takenDays: taken, pendingDays: pending, accruedToDateDays: accrued,
      availableDays: available, availableAfterPendingDays: roundHalf(available - pending),
    };
  });
}

// ----- legacy shape (portal before leave v2; kept so older callers read through the same function) -----------------------

export interface LeaveBalanceInput { leaveTypeId: string; allowanceDays: number | null }
export interface LeaveBalanceRecord extends StoredLeaveRange { leaveTypeId: string; status: string }
export interface LegacyLeaveBalance { leaveTypeId: string; allowanceDays: number | null; usedDays: number; pendingDays: number; remainingDays: number | null }

/**
 * @deprecated use computeLeaveBalances. The pre-v2 shape — allowance = the type's yearly allowance (no allocation rows, no
 * proration, working days), used = approved, pending = pending + info requested, remaining = allowance − used − pending —
 * computed by computeLeaveBalances so there is still exactly one rule.
 */
export function leaveBalances(types: readonly LeaveBalanceInput[], records: readonly LeaveBalanceRecord[], cal: WorkingCalendar, year: number): LegacyLeaveBalance[] {
  const computed = computeLeaveBalances({
    year, asOf: `${year}-12-31`, joiningDate: null, allocations: [], records, calendar: cal,
    types: types.map((t) => ({ leaveTypeId: t.leaveTypeId, annualAllowanceDays: t.allowanceDays, countMode: 'working', accrual: 'none' })),
  });
  return computed.map((b) => ({ leaveTypeId: b.leaveTypeId, allowanceDays: b.entitlementDays, usedDays: b.takenDays, pendingDays: b.pendingDays, remainingDays: b.availableAfterPendingDays }));
}

// ----- comp-off: credits against the dates they pay for (leave v2 review P2-4) --------------------------------------------

/** A usable credit: what is still free on it and the last date it may pay for (its expiry). */
export interface CompOffCreditSlot { id: string; freeDays: number; expiresOn: string; workedOn?: string | null }
/** One date a comp-off leave charges (1, or 0.5 for a half day). */
export interface CompOffDemandDay { date: string; days: number; /** Which request the date belongs to (reservations of other requests). */ key?: string }
export interface CompOffAllocation {
  /** Days taken per credit (the usage rows), per request key ('' when none). */
  usages: Array<{ creditId: string; days: number; key: string }>;
  /** Days no credit could pay for, per request key. */
  shortfall: Map<string, number>;
}

/**
 * The dates a comp-off leave asks credits for: its charged dates (per-date calendar, the type's count mode). When the stored
 * `days` (the document) no longer match those dates — the calendar changed since submission — the stored figure is asked for
 * on the leave's LAST date, so every credit used must still be valid at the end of the leave (never looser than the dates).
 */
export function compOffDemandOf(range: StoredLeaveRange, cal: WorkingCalendar, mode: LeaveCountMode, key?: string): CompOffDemandDay[] {
  const dates = chargedLeaveDates(range, cal, mode);
  const counted = roundHalf(dates.reduce((a, d) => a + d.days, 0));
  const tag = key === undefined ? {} : { key };
  if (range.days !== null && range.days !== undefined && Number.isFinite(range.days) && roundHalf(range.days) !== counted) {
    return range.days > 0 ? [{ date: range.endDate, days: roundHalf(range.days), ...tag }] : [];
  }
  return dates.map((d) => ({ ...d, ...tag }));
}

/**
 * Pay comp-off leave dates from credits (Finance parity B-60 with review P2-4): a credit pays only for leave dated ON OR
 * BEFORE its expiry. Dates are served in date order, each from the eligible credit expiring first (then the earliest worked
 * day) — the earliest-deadline-first greedy, which never leaves a date unpaid that some assignment could have paid. With
 * `lastKey` (an application being checked) the other requests' dates are served first — they reserve their credits — and
 * the application's dates take what is left. Pure; half days in 0.5 steps.
 */
export function allocateCompOffCredits(credits: readonly CompOffCreditSlot[], demand: readonly CompOffDemandDay[], opts: { lastKey?: string } = {}): CompOffAllocation {
  const order = [...credits].sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || (a.workedOn ?? '').localeCompare(b.workedOn ?? '') || a.id.localeCompare(b.id));
  const free = new Map(order.map((c) => [c.id, roundHalf(Math.max(0, c.freeDays))]));
  const used = new Map<string, number>();
  const shortfall = new Map<string, number>();
  const serve = (days: readonly CompOffDemandDay[]): void => {
    for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
      const key = d.key ?? '';
      let need = roundHalf(d.days);
      for (const c of order) {
        if (need <= 0) break;
        if (c.expiresOn < d.date) continue;
        const left = free.get(c.id) ?? 0;
        if (left <= 0) continue;
        const take = roundHalf(Math.min(left, need));
        free.set(c.id, roundHalf(left - take));
        need = roundHalf(need - take);
        used.set(`${key}\u0000${c.id}`, roundHalf((used.get(`${key}\u0000${c.id}`) ?? 0) + take));
      }
      if (need > 0) shortfall.set(key, roundHalf((shortfall.get(key) ?? 0) + need));
    }
  };
  if (opts.lastKey === undefined) serve(demand);
  else {
    serve(demand.filter((d) => (d.key ?? '') !== opts.lastKey));
    serve(demand.filter((d) => (d.key ?? '') === opts.lastKey));
  }
  const usages = [...used.entries()].map(([k, v]) => { const [key, creditId] = k.split('\u0000') as [string, string]; return { creditId, days: v, key }; });
  return { usages, shortfall };
}
