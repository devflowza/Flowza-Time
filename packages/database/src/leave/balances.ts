import { sql } from 'kysely';
import { computeLeaveBalances, type BalanceCreditInput, type LeaveBalance, type LeaveCountMode, type LeaveAccrual, type WorkingCalendar } from '@flowza/domain';
import type { Trx } from '../context.js';
import { isoDateOf } from '../attendance/day-marks.js';
import { loadEmployeeWorkingCalendars } from '../attendance/working-calendar.js';

/**
 * Leave v2 read primitives shared by the API and the worker (HR portal Prompt 7): the policy of the leave types, the
 * working calendars of employees (bulk), and `loadLeaveBalances` — the one IO wrapper around the domain's
 * computeLeaveBalances. Every screen, the apply warnings, the approval context, the unexcused-day charger and the year
 * close read balances through it; nothing stores a counter.
 *
 * Runs under whatever context the caller established. Callers that authorise a user for an employee first (API) usually
 * run it in the organisation's system scope, so a branch-scoped reader sees the same figures HR sees.
 */

export const COMP_OFF_SYSTEM_KEY = 'COMP_OFF';

export interface LeaveTypePolicy {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  color: string | null;
  isPaid: boolean;
  treatAsPresent: boolean;
  annualAllowanceDays: number | null;
  status: string;
  requiresApproval: boolean;
  countMode: LeaveCountMode;
  maxConsecutiveDays: number | null;
  advanceNoticeDays: number;
  applicableGender: 'all' | 'male' | 'female';
  /** Leave v2 review (B-41): the employment types the type applies to; null = every type. Read with `leaveTypeAppliesTo`. */
  applicableEmploymentTypes: string[] | null;
  accrual: LeaveAccrual;
  carryForwardMaxDays: number;
  carryForwardExpiryMonths: number | null;
  isSpecial: boolean;
  allowHalfDay: boolean;
  portalVisible: boolean;
  systemKey: string | null;
  createdAt: Date;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const dv = (date: string) => sql<Date>`${date}::date`;

type RawTypeRow = { id: string; code: string; name: string; nameAr: string | null; color: string | null; isPaid: boolean; treatAsPresent: boolean; annualAllowanceDays: unknown; status: string; requiresApproval: boolean; countMode: string; maxConsecutiveDays: number | null; advanceNoticeDays: number; applicableGender: string; applicableEmploymentTypes: string[] | null; accrual: string; carryForwardMaxDays: unknown; carryForwardExpiryMonths: number | null; isSpecial: boolean; allowHalfDay: boolean; portalVisible: boolean; systemKey: string | null; createdAt: Date };
export function toLeaveTypePolicy(t: RawTypeRow): LeaveTypePolicy {
  return {
    id: t.id, code: String(t.code), name: t.name, nameAr: t.nameAr, color: t.color, isPaid: t.isPaid, treatAsPresent: t.treatAsPresent, annualAllowanceDays: numOrNull(t.annualAllowanceDays), status: t.status,
    requiresApproval: t.requiresApproval, countMode: t.countMode === 'calendar' ? 'calendar' : 'working', maxConsecutiveDays: t.maxConsecutiveDays, advanceNoticeDays: t.advanceNoticeDays,
    applicableGender: t.applicableGender === 'male' || t.applicableGender === 'female' ? t.applicableGender : 'all',
    applicableEmploymentTypes: Array.isArray(t.applicableEmploymentTypes) && t.applicableEmploymentTypes.length > 0 ? [...t.applicableEmploymentTypes] : null, accrual: t.accrual === 'monthly' ? 'monthly' : 'none',
    carryForwardMaxDays: num(t.carryForwardMaxDays), carryForwardExpiryMonths: t.carryForwardExpiryMonths, isSpecial: t.isSpecial, allowHalfDay: t.allowHalfDay, portalVisible: t.portalVisible, systemKey: t.systemKey, createdAt: t.createdAt,
  };
}
export const LEAVE_TYPE_COLUMNS = ['id', 'code', 'name', 'nameAr', 'color', 'isPaid', 'treatAsPresent', 'annualAllowanceDays', 'status', 'requiresApproval', 'countMode', 'maxConsecutiveDays', 'advanceNoticeDays', 'applicableGender', 'applicableEmploymentTypes', 'accrual', 'carryForwardMaxDays', 'carryForwardExpiryMonths', 'isSpecial', 'allowHalfDay', 'portalVisible', 'systemKey', 'createdAt'] as const;

/** Leave types of the organisation with their v2 policy (active ones unless `includeInactive`), ordered by name. */
export async function loadLeaveTypePolicies(trx: Trx, organizationId: string, opts: { includeInactive?: boolean } = {}): Promise<LeaveTypePolicy[]> {
  let q = trx.selectFrom('leaveTypes').select(LEAVE_TYPE_COLUMNS).where('organizationId', '=', organizationId);
  if (!opts.includeInactive) q = q.where('status', '=', 'active');
  return (await q.orderBy('name').execute()).map((r) => toLeaveTypePolicy(r as unknown as RawTypeRow));
}

/**
 * Leave-counting calendars of several employees for [from, to] — the per-date working calendar (leave v2 review P1-1 /
 * P1-2, `loadEmployeeWorkingCalendars`): each date uses the branch the employee was placed in on that date, its weekly offs
 * and holiday calendar (branch-limited holidays honoured, else the organisation's default calendar) and the rotation
 * pattern's off days — exactly what the attendance engine uses, so a rostered-off day or a pre-transfer weekly off is never
 * charged as leave. `weeklyOffDays` / `holidays` of the result describe the current placement (display).
 */
export async function loadWorkingCalendars(trx: Trx, organizationId: string, employeeIds: readonly string[], from: string, to: string): Promise<Map<string, WorkingCalendar>> {
  const out = new Map<string, WorkingCalendar>();
  if (employeeIds.length === 0) return out;
  const { calendars } = await loadEmployeeWorkingCalendars(trx, organizationId, employeeIds, { from, to });
  for (const [id, c] of calendars) out.set(id, c.calendar);
  return out;
}

export interface LoadLeaveBalancesOptions {
  year: number;
  /** Today in the organisation's timezone (accrual, carry-forward expiry, comp-off expiry). */
  asOf: string;
  /** Pre-loaded types (e.g. already fetched by the caller); default: the organisation's active types. */
  types?: readonly LeaveTypePolicy[];
  /** Leave records to leave out (the request being edited, so it is not counted against itself). */
  excludeRecordIds?: readonly string[];
}

/** Balances per employee for one year: Map employeeId → one LeaveBalance per type (same order as the types). */
export async function loadLeaveBalances(trx: Trx, organizationId: string, employeeIds: readonly string[], opts: LoadLeaveBalancesOptions): Promise<Map<string, LeaveBalance[]>> {
  const out = new Map<string, LeaveBalance[]>();
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return out;
  const types = opts.types ?? await loadLeaveTypePolicies(trx, organizationId);
  const from = `${opts.year}-01-01`; const to = `${opts.year}-12-31`;
  let records = trx.selectFrom('leaveRecords').select(['id', 'employeeId', 'leaveTypeId', 'status', 'startDate', 'endDate', 'isHalfDay', 'days'])
    .where('organizationId', '=', organizationId).where('employeeId', 'in', ids).where('status', 'in', ['APPROVED', 'PENDING', 'INFO_REQUESTED'])
    .where('startDate', '<=', dv(to)).where('endDate', '>=', dv(from));
  if (opts.excludeRecordIds?.length) records = records.where('id', 'not in', [...opts.excludeRecordIds]);
  const hasCompOff = types.some((t) => t.systemKey === COMP_OFF_SYSTEM_KEY);
  const [employees, allocations, recordRows, credits, calendars] = await Promise.all([
    trx.selectFrom('employees').select(['id', 'joiningDate']).where('organizationId', '=', organizationId).where('id', 'in', ids).execute(),
    trx.selectFrom('leaveAllocations').select(['employeeId', 'leaveTypeId', 'allocatedDays', 'carriedForwardDays', 'carriedForwardExpiresOn', 'openingBalanceDays', 'adjustmentDays'])
      .where('organizationId', '=', organizationId).where('employeeId', 'in', ids).where('year', '=', opts.year).execute(),
    records.execute(),
    hasCompOff ? trx.selectFrom('compOffCredits').select(['employeeId', 'status', 'daysEarned', 'usedDays', 'expiresOn'])
      .where('organizationId', '=', organizationId).where('employeeId', 'in', ids).where('status', 'in', ['approved', 'partially_used', 'used']).execute() : Promise.resolve([]),
    loadWorkingCalendars(trx, organizationId, ids, from, to),
  ]);
  const typeInputs = types.map((t) => ({ leaveTypeId: t.id, annualAllowanceDays: t.annualAllowanceDays, countMode: t.countMode, accrual: t.accrual, compOff: t.systemKey === COMP_OFF_SYSTEM_KEY }));
  for (const e of employees) {
    const creditRows: BalanceCreditInput[] = credits.filter((c) => c.employeeId === e.id).map((c) => ({ status: c.status, daysEarned: num(c.daysEarned), usedDays: num(c.usedDays), expiresOn: c.expiresOn === null ? null : isoDateOf(c.expiresOn) }));
    out.set(e.id, computeLeaveBalances({
      year: opts.year, asOf: opts.asOf, joiningDate: isoDateOf(e.joiningDate), types: typeInputs,
      allocations: allocations.filter((a) => a.employeeId === e.id).map((a) => ({ leaveTypeId: a.leaveTypeId, allocatedDays: num(a.allocatedDays), carriedForwardDays: num(a.carriedForwardDays), carriedForwardExpiresOn: a.carriedForwardExpiresOn === null ? null : isoDateOf(a.carriedForwardExpiresOn), openingBalanceDays: num(a.openingBalanceDays), adjustmentDays: num(a.adjustmentDays) })),
      // stored `days` (the value at submission) count for a leave inside the year; a transfer never moves history (review P1-2)
      records: recordRows.filter((r) => r.employeeId === e.id).map((r) => ({ leaveTypeId: r.leaveTypeId, status: r.status, startDate: isoDateOf(r.startDate), endDate: isoDateOf(r.endDate), isHalfDay: r.isHalfDay, days: r.days === null ? null : Number(r.days) })),
      credits: creditRows,
      calendar: calendars.get(e.id) ?? { weeklyOffDays: [], holidays: new Set() },
    }));
  }
  return out;
}

/** The organisation's comp-off leave type (system key COMP_OFF), or null. */
export async function compOffLeaveType(trx: Trx, organizationId: string): Promise<LeaveTypePolicy | null> {
  const row = await trx.selectFrom('leaveTypes').select(LEAVE_TYPE_COLUMNS).where('organizationId', '=', organizationId).where('systemKey', '=', COMP_OFF_SYSTEM_KEY).executeTakeFirst();
  return row ? toLeaveTypePolicy(row as unknown as RawTypeRow) : null;
}
