import { sql } from 'kysely';
import { DateTime } from 'luxon';
import {
  ATTENDANCE_SUMMARY_EXPORT_MAX_ROWS,
  type AttendanceCalendarDayDto, type AttendanceCalendarQuery, type AttendanceCalendarRowDto, type AttendanceEngineOutcomeDto, type AttendanceEventType, type AttendancePreviewDto,
  type AttendancePreviewInput, type AttendanceRecordEditInput, type AttendanceRecordEditResultDto, type AttendanceStatus, type AttendanceSummaryExportDto, type AttendanceSummaryExportQuery,
  type AttendanceSummaryFigures, type AttendanceSummaryQuery, type AttendanceSummaryRowDto, type AttendanceTimelineDto, type AttendanceTimelineQuery, type BulkAttendanceStatusInput,
  type BulkStatusItemResultDto, type BulkStatusResultDto, type CreateCorrectionInput, type FiledCorrectionDto, type ManualStatusDto, type ManualStatusesQuery, type PlannedCorrectionDto,
  type PunchFactsDto, type TimelineRawDto, type UnmatchedActionResultDto, type UnmatchedAssignInput, type UnmatchedIgnoreInput, type UnmatchedPunchGroupDto, type UnmatchedPunchesQuery,
  type UnmatchedRestoreInput, type UnmatchedSuggestionDto,
} from '@flowza/contracts';
import { loadDailyInputs, type LoadedDailyInputs, type Trx } from '@flowza/database';
import { calculateDailyRecord, type DailyCalculationResult, type EngineEvent, type MembershipGrant } from '@flowza/domain';
import { AppError, errors, event } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireAnyPermission, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { toCsvLine } from '../../lib/csv.js';
import { enqueueJob } from '../../lib/jobs.js';
import { isoDate, isoDateTime, isoDateTimeOrNull, jsonObject } from '../../lib/mappers.js';
import { likeContains, toCount } from '../../lib/pagination.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { createCorrection } from '../features/attendance.service.js';
import { systemStep } from '../features/context.js';
import { dv } from '../features/sql-helpers.js';

/**
 * HR attendance workspace (HR portal Prompt 6a): the register's Add / Edit record (with a policy preview), bulk status, the
 * punch timeline, the calendar grid, the monthly summary (+ CSV) and the unmatched-punch triage.
 *
 * Writes never touch a daily record directly: a record edit files ADD_PUNCH / EDIT_PUNCH / SET_STATUS corrections through the
 * exported `createCorrection` (the one correction path — approval routing, auto-approval for HR, audit and the worker's
 * APPLY_CORRECTION → RECOMPUTE_DAILY chain), and the triage writes the device identity mapping the normaliser reads first
 * (`device_employee_states`) before re-queueing the rows. Reads run under the caller's RLS; the engine's inputs are loaded
 * in the organisation's system scope (read-only) AFTER the caller was authorised for the employee, so the preview sees
 * exactly what the recompute will see even when the caller's role cannot read, say, raw payloads or leave records.
 */

const FUTURE_TOLERANCE_MS = 5 * 60_000;
const TIMELINE_RAW_LIMIT = 500;
const IGNORED_LOOKBACK_DAYS = 180;
const SUMMARY_EXPORTS_PER_HOUR = 30;

// ---- shared helpers ---------------------------------------------------------------------------------------------------

function outcome(r: DailyCalculationResult): AttendanceEngineOutcomeDto {
  return {
    status: r.status, flags: [...r.flags], firstInAt: r.firstInAt, lastOutAt: r.lastOutAt, workedMinutes: r.workedMinutes, breakMinutes: r.breakMinutes,
    lateMinutes: r.lateMinutes, earlyDepartureMinutes: r.earlyDepartureMinutes, overtimeMinutes: r.overtimeMinutes, scheduledMinutes: r.scheduledMinutes,
    punchCount: r.punchCount, lopDays: r.lopDays,
  };
}

async function periodLocked(trx: Trx, orgId: string, branchId: string | null, date: string): Promise<boolean> {
  const res = await sql<{ locked: boolean }>`select app.is_period_locked(${orgId}::uuid, ${branchId}::uuid, ${date}::date) as locked`.execute(trx);
  return res.rows[0]?.locked === true;
}

/** Sliding hourly quota per organisation (system-owned `usage_quotas` rows) → RATE_LIMITED above the limit. */
async function consumeQuota(trx: Trx, orgId: string, metric: string, limit: number): Promise<void> {
  const windowSeconds = 3600;
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const res = await sql<{ count: number }>`
    insert into public.usage_quotas (organization_id, metric, window_start, window_seconds, count) values (${orgId}::uuid, ${metric}, ${windowStart}, ${windowSeconds}, 1)
    on conflict (organization_id, metric, window_start) do update set count = public.usage_quotas.count + 1 returning count`.execute(trx);
  const count = res.rows[0]?.count ?? 1;
  if (count > limit) throw new AppError('RATE_LIMITED', `At most ${limit} ${metric.replace(/_/g, ' ')} per hour per organisation.`, { details: { metric, limit }, retryAfterMs: windowStart.getTime() + windowSeconds * 1000 - Date.now() });
}

/** Month bounds (`YYYY-MM`, inclusive local dates) and every date of the month. */
function monthRange(month: string): { from: string; to: string; days: string[] } {
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  if (!start.isValid) throw errors.validation('Invalid month.', { issues: [{ path: 'month', message: 'Expected YYYY-MM' }] });
  const end = start.endOf('month');
  const days: string[] = [];
  for (let d = start; d <= end; d = d.plus({ days: 1 })) days.push(d.toISODate()!);
  return { from: start.toISODate()!, to: end.toISODate()!, days };
}

async function orgTimezone(trx: Trx, orgId: string): Promise<string> {
  const row = await withSystemScope(trx, orgId, (t) => t.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst());
  const tz = row?.timezone ?? 'UTC';
  return DateTime.now().setZone(tz).isValid ? tz : 'UTC';
}

/** Branch / department names for ids the caller already sees (names are not sensitive; managers hold no branch.view). */
async function namesOf(trx: Trx, orgId: string, branchIds: string[], departmentIds: string[]): Promise<{ branches: Map<string, string>; departments: Map<string, string> }> {
  return withSystemScope(trx, orgId, async (t) => {
    const b = branchIds.length ? await t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute() : [];
    const d = departmentIds.length ? await t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', departmentIds).execute() : [];
    return { branches: new Map(b.map((x) => [x.id, x.name])), departments: new Map(d.map((x) => [x.id, x.name])) };
  });
}

/** The latest applied SET_STATUS correction per (employee, date) in a range — the days whose status is a manual override. */
async function manualOverrides(trx: Trx, orgId: string, employeeIds: string[] | null, from: string, to: string): Promise<Map<string, { status: AttendanceStatus; correctionId: string; reason: string; appliedAt: Date | null; employeeId: string; date: string }>> {
  if (employeeIds && employeeIds.length === 0) return new Map();
  let q = trx.selectFrom('attendanceCorrections').select(['id', 'employeeId', 'attendanceDate', 'proposedStatus', 'reason', 'appliedAt'])
    .where('organizationId', '=', orgId).where('type', '=', 'SET_STATUS').where('status', '=', 'APPLIED').where('proposedStatus', 'is not', null)
    .where('attendanceDate', '>=', dv(from)).where('attendanceDate', '<=', dv(to));
  if (employeeIds) q = q.where('employeeId', 'in', employeeIds);
  const rows = await q.orderBy('appliedAt', 'asc').orderBy('id', 'asc').execute();
  const out = new Map<string, { status: AttendanceStatus; correctionId: string; reason: string; appliedAt: Date | null; employeeId: string; date: string }>();
  // ascending, so the latest applied override of a day wins (the recompute's own rule)
  for (const r of rows) {
    const date = isoDate(r.attendanceDate);
    out.set(`${r.employeeId}|${date}`, { status: r.proposedStatus as AttendanceStatus, correctionId: r.id, reason: r.reason, appliedAt: r.appliedAt, employeeId: r.employeeId, date });
  }
  return out;
}

// ---- preview + record edit ----------------------------------------------------------------------------------------------

interface AttributedPunch { eventId: string; punchedAt: string; eventType: AttendanceEventType }

interface DayPlan {
  employee: { id: string; employeeNumber: string; displayName: string; branchId: string };
  loaded: LoadedDailyInputs;
  current: DailyCalculationResult;
  preview: DailyCalculationResult;
  inPunch: AttributedPunch | null;
  outPunch: AttributedPunch | null;
  plan: PlannedCorrectionDto[];
  unchanged: number;
  locked: boolean;
  record: { id: string; status: AttendanceStatus } | null;
  manual: { status: AttendanceStatus; correctionId: string } | null;
  pendingCorrections: number;
}

function toIso(v: string): string { return new Date(v).toISOString(); }

/**
 * The first IN and the last OUT the engine attributed to the day (the punches an HR check-in / check-out edit replaces), and
 * the plan of corrections that turns the day into the proposed one, simulated through the pure engine on the real inputs.
 */
async function planDay(trx: Trx, orgId: string, grant: MembershipGrant, input: { employeeId: string; date: string; inAt?: string | null; outAt?: string | null; status?: AttendanceStatus }): Promise<DayPlan> {
  const now = new Date();
  const emp = await trx.selectFrom('employees').select(['id', 'employeeNumber', 'displayName', 'branchId', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', input.employeeId).executeTakeFirst();
  if (!emp || emp.deletedAt) throw errors.notFound('Employee', input.employeeId);
  requireBranchAccess(grant, emp.branchId);
  const loaded = await withSystemScope(trx, orgId, (t) => loadDailyInputs(t, orgId, emp.id, input.date, now));
  if (!loaded) throw errors.notFound('Employee', input.employeeId);
  const current = calculateDailyRecord(loaded.input);

  const eventsById = new Map(loaded.input.events.map((e) => [e.id, e]));
  const attributed = (role: 'IN' | 'OUT'): AttributedPunch[] => current.trace.punches
    .filter((p) => p.role === role)
    .map((p) => ({ eventId: p.eventId, punchedAt: toIso(p.punchedAt), eventType: eventsById.get(p.eventId)?.eventType ?? 'PUNCH' }))
    .sort((a, b) => Date.parse(a.punchedAt) - Date.parse(b.punchedAt));
  const ins = attributed('IN');
  const outs = attributed('OUT');
  const inPunch = ins[0] ?? null;
  const outPunch = outs[outs.length - 1] ?? null;

  // proposed times: inside the engine's event window of the date, not in the future, check-out after check-in
  const windowStart = DateTime.fromISO(input.date, { zone: loaded.timezone }).minus({ days: 1 }).startOf('day');
  const windowEnd = DateTime.fromISO(input.date, { zone: loaded.timezone }).plus({ days: 2 }).startOf('day');
  for (const [key, value] of [['inAt', input.inAt], ['outAt', input.outAt]] as const) {
    if (!value) continue;
    const at = Date.parse(value);
    if (at < windowStart.toMillis() || at >= windowEnd.toMillis()) throw errors.validation('The time must fall within the attendance day (from the day before to the day after).', { issues: [{ path: key, message: 'Outside the attendance day' }] });
    if (at > now.getTime() + FUTURE_TOLERANCE_MS) throw errors.validation('A punch cannot be in the future.', { issues: [{ path: key, message: 'In the future' }] });
  }
  const effectiveIn = input.inAt ?? current.firstInAt;
  const effectiveOut = input.outAt ?? current.lastOutAt;
  if ((input.inAt || input.outAt) && effectiveIn && effectiveOut && Date.parse(effectiveOut) <= Date.parse(effectiveIn)) {
    throw errors.validation('Check-out must be after check-in.', { issues: [{ path: input.outAt ? 'outAt' : 'inAt', message: 'Check-out must be after check-in' }] });
  }

  const plan: PlannedCorrectionDto[] = [];
  let unchanged = 0;
  const events: EngineEvent[] = loaded.input.events.map((e) => ({ ...e }));
  const propose = (value: string | null | undefined, existing: AttributedPunch | null, direction: 'IN' | 'OUT'): void => {
    if (!value) return;
    const at = toIso(value);
    const synthetic = (eventType: AttendanceEventType): EngineEvent => ({ id: `preview-${direction.toLowerCase()}`, punchedAt: at, eventType, source: 'CORRECTION', verificationMethod: 'manual', deviceId: null, voided: false });
    if (existing) {
      if (Date.parse(existing.punchedAt) === Date.parse(at)) { unchanged += 1; return; }
      // the replacement keeps the original's type, so a directional device punch stays directional
      plan.push({ type: 'EDIT_PUNCH', originalEventId: existing.eventId, originalPunchedAt: existing.punchedAt, proposedPunchedAt: at, proposedEventType: existing.eventType, proposedStatus: null });
      const original = events.find((e) => e.id === existing.eventId);
      if (original) original.voided = true;
      events.push(synthetic(existing.eventType));
    } else {
      const eventType: AttendanceEventType = direction === 'IN' ? 'PUNCH_IN' : 'PUNCH_OUT';
      plan.push({ type: 'ADD_PUNCH', originalEventId: null, originalPunchedAt: null, proposedPunchedAt: at, proposedEventType: eventType, proposedStatus: null });
      events.push(synthetic(eventType));
    }
  };
  propose(input.inAt, inPunch, 'IN');
  propose(input.outAt, outPunch, 'OUT');
  const preview = plan.length ? calculateDailyRecord({ ...loaded.input, events }) : current;
  if (input.status) plan.push({ type: 'SET_STATUS', originalEventId: null, originalPunchedAt: null, proposedPunchedAt: null, proposedEventType: null, proposedStatus: input.status });

  const locked = await periodLocked(trx, orgId, emp.branchId, input.date);
  const record = await trx.selectFrom('attendanceDailyRecords').select(['id', 'status']).where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('attendanceDate', '=', dv(input.date)).executeTakeFirst();
  const manual = (await manualOverrides(trx, orgId, [emp.id], input.date, input.date)).get(`${emp.id}|${input.date}`) ?? null;
  const pending = await trx.selectFrom('attendanceCorrections').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('employeeId', '=', emp.id)
    .where('attendanceDate', '=', dv(input.date)).where('status', 'in', ['PENDING', 'APPROVED']).executeTakeFirst();
  return {
    employee: { id: emp.id, employeeNumber: String(emp.employeeNumber), displayName: emp.displayName, branchId: emp.branchId },
    loaded, current, preview, inPunch, outPunch, plan, unchanged, locked,
    record: record ? { id: record.id, status: record.status } : null,
    manual: manual ? { status: manual.status, correctionId: manual.correctionId } : null,
    pendingCorrections: toCount(pending?.n),
  };
}

/** POST /attendance/preview — the policy-derived day with the proposed check-in / check-out. Runs the engine; writes nothing. */
export async function previewRecord(deps: ApiDeps, actor: Actor, orgId: string, input: AttendancePreviewInput): Promise<AttendancePreviewDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  return runUser(deps.db, actor, async (trx) => {
    const p = await planDay(trx, orgId, grant, input);
    const shift = p.loaded.input.shift;
    return {
      employeeId: p.employee.id, employeeNumber: p.employee.employeeNumber, employeeName: p.employee.displayName, date: input.date, timezone: p.loaded.timezone,
      recordId: p.record?.id ?? null,
      shift: shift ? { id: shift.id, code: shift.code, name: shift.name, expectedStartAt: p.current.expectedStartAt, expectedEndAt: p.current.expectedEndAt, scheduledMinutes: p.current.scheduledMinutes } : null,
      current: outcome(p.current), preview: outcome(p.preview),
      statusSource: p.manual ? 'MANUAL' : 'AUTO', manualStatus: p.manual?.status ?? null,
      punches: { in: p.inPunch ? { eventId: p.inPunch.eventId, punchedAt: p.inPunch.punchedAt } : null, out: p.outPunch ? { eventId: p.outPunch.eventId, punchedAt: p.outPunch.punchedAt } : null },
      plan: p.plan, pendingCorrections: p.pendingCorrections, locked: p.locked,
    };
  });
}

function correctionInputOf(employeeId: string, date: string, reason: string, item: PlannedCorrectionDto): CreateCorrectionInput {
  switch (item.type) {
    case 'ADD_PUNCH': return { employeeId, attendanceDate: date, type: 'ADD_PUNCH', proposedPunchedAt: item.proposedPunchedAt!, proposedEventType: item.proposedEventType ?? 'PUNCH', reason };
    case 'EDIT_PUNCH': return { employeeId, attendanceDate: date, type: 'EDIT_PUNCH', originalEventId: item.originalEventId!, proposedPunchedAt: item.proposedPunchedAt!, proposedEventType: item.proposedEventType ?? 'PUNCH', reason };
    case 'SET_STATUS': return { employeeId, attendanceDate: date, type: 'SET_STATUS', proposedStatus: item.proposedStatus!, reason };
    default: {
      const exhaustive: never = item.type;
      throw errors.validation(`Unknown correction type ${String(exhaustive)}.`);
    }
  }
}

const HR_EDIT_PERMISSIONS = ['attendance.view', 'attendance.correct', 'attendance.approve'] as const;

/**
 * POST /attendance/record-edits — HR's Add / Edit record: the preview's plan filed as corrections, one `createCorrection` per
 * item (check-in, check-out, status) in that order. HR holds attendance.approve, so without a configured approval workflow each
 * is auto-approved and applied by the worker within seconds (the path corrections have always taken). Every correction is its
 * own transaction: when a later item fails after earlier ones were filed, the result names the failure and keeps the filed ones
 * (each is individually valid and audited) rather than pretending nothing happened.
 */
export async function editRecord(deps: ApiDeps, actor: Actor, orgId: string, input: AttendanceRecordEditInput): Promise<AttendanceRecordEditResultDto> {
  const grant = requirePermission(actor.principal, orgId, ...HR_EDIT_PERMISSIONS);
  const plan = await runUser(deps.db, actor, (trx) => planDay(trx, orgId, grant, input));
  if (plan.locked) throw errors.periodLocked('The attendance period for this date is locked; unlock it before editing the record.');
  if (plan.plan.length === 0) throw errors.validation('Nothing to change: the times already match the record.', { issues: [{ path: 'inAt', message: 'Unchanged' }] });
  const corrections: FiledCorrectionDto[] = [];
  let failed: AttendanceRecordEditResultDto['failed'] = null;
  for (const item of plan.plan) {
    try {
      const res = await createCorrection(deps, actor, orgId, correctionInputOf(plan.employee.id, input.date, input.reason, item));
      corrections.push({ id: res.id, type: item.type, status: res.status, approval: res.approval });
    } catch (err) {
      if (corrections.length === 0 || !AppError.is(err)) throw err;
      failed = { type: item.type, code: err.code, message: err.message };
      break;
    }
  }
  return { corrections, applied: failed === null && corrections.every((c) => c.approval === 'AUTO_APPROVED'), failed, unchanged: plan.unchanged };
}

/**
 * POST /attendance/bulk-status — one SET_STATUS correction per (employee, date), one reason. Items are independent: a refusal
 * (locked period, employee outside the caller's scope, an equivalent correction already pending) is reported per item and the
 * others still go through. At most 200 items per request (contract).
 */
export async function bulkStatus(deps: ApiDeps, actor: Actor, orgId: string, input: BulkAttendanceStatusInput): Promise<BulkStatusResultDto> {
  requirePermission(actor.principal, orgId, ...HR_EDIT_PERMISSIONS);
  const results: BulkStatusItemResultDto[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    const key = `${item.employeeId}|${item.date}`;
    if (seen.has(key)) { results.push({ ...item, ok: false, error: { code: 'DUPLICATE_ITEM', message: 'The same employee and date appear twice in this request.' } }); continue; }
    seen.add(key);
    try {
      const res = await createCorrection(deps, actor, orgId, { employeeId: item.employeeId, attendanceDate: item.date, type: 'SET_STATUS', proposedStatus: input.status, reason: input.reason });
      results.push({ ...item, ok: true, correctionId: res.id, approval: res.approval });
    } catch (err) {
      if (!AppError.is(err)) {
        deps.log.error(event('attendance_bulk_status_item_failed', { organizationId: orgId, requestId: actor.requestId, err: (err as Error).message }));
        results.push({ ...item, ok: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
        continue;
      }
      results.push({ ...item, ok: false, error: { code: err.code, message: err.message } });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  const summary: BulkStatusResultDto = {
    results, succeeded, failed: results.length - succeeded,
    autoApproved: results.filter((r) => r.approval === 'AUTO_APPROVED').length, pending: results.filter((r) => r.approval === 'PENDING').length,
  };
  if (succeeded > 0) {
    // one row for the bulk action itself; every correction carries its own audit trail
    await runUser(deps.db, actor, (trx) => audit(trx, actor, orgId, 'attendance.bulk_status_set', 'attendance_correction', {
      newValue: { status: input.status, items: input.items.length, succeeded, failed: summary.failed, autoApproved: summary.autoApproved, pending: summary.pending }, reason: input.reason,
    }));
  }
  return summary;
}

// ---- Auto / Manual ---------------------------------------------------------------------------------------------------------

/** GET /attendance/manual-statuses — applied manual overrides in a range (the `Manual` chip of the register). */
export async function listManualStatuses(deps: ApiDeps, actor: Actor, orgId: string, q: ManualStatusesQuery): Promise<ManualStatusDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  requireBranchAccess(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let employeeIds: string[] | null = q.employeeId ? [q.employeeId] : null;
    if (q.branchId && !q.employeeId) employeeIds = (await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('branchId', '=', q.branchId).execute()).map((e) => e.id);
    const map = await manualOverrides(trx, orgId, employeeIds, q.from, q.to);
    return [...map.values()].map((m) => ({ employeeId: m.employeeId, date: m.date, status: m.status, correctionId: m.correctionId, reason: m.reason, appliedAt: isoDateTimeOrNull(m.appliedAt) }));
  });
}

// ---- calendar -----------------------------------------------------------------------------------------------------------------

type EmployeeFilter = { branchScope: string[] | null; departmentId?: string; employeeId?: string; search?: string };

function employeesInMonth(trx: Trx, orgId: string, from: string, to: string, f: EmployeeFilter) {
  let q = trx.selectFrom('employees as e').where('e.organizationId', '=', orgId).where('e.deletedAt', 'is', null)
    .where('e.joiningDate', '<=', dv(to)).where((eb) => eb.or([eb('e.exitDate', 'is', null), eb('e.exitDate', '>=', dv(from))]));
  if (f.employeeId) q = q.where('e.id', '=', f.employeeId);
  if (f.branchScope) q = q.where('e.branchId', 'in', f.branchScope.length ? f.branchScope : ['00000000-0000-0000-0000-000000000000']);
  if (f.departmentId) q = q.where('e.departmentId', '=', f.departmentId);
  if (f.search) { const like = likeContains(f.search); q = q.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like)])); }
  return q;
}

/** Organisation-wide attendance.view (branch-scoped as usual), or a line manager's team (RLS decides which rows). */
function readScope(actor: Actor, orgId: string, branchId: string | undefined): { grant: MembershipGrant; branchScope: string[] | null } {
  const grant = requireAnyPermission(actor.principal, orgId, 'attendance.view', 'attendance.view_team');
  if (hasPermission(grant, 'attendance.view')) return { grant, branchScope: branchFilter(grant, branchId) };
  return { grant, branchScope: branchId ? [branchId] : null };
}

/** GET /attendance/calendar — a month grid per employee: status, flags, times and hours per day, and whether the status is manual. */
export async function calendar(deps: ApiDeps, actor: Actor, orgId: string, q: AttendanceCalendarQuery): Promise<{ data: AttendanceCalendarRowDto[]; total: number; meta: { month: string; days: string[]; today: string } }> {
  const { branchScope } = readScope(actor, orgId, q.branchId);
  const { from, to, days } = monthRange(q.month);
  return runUser(deps.db, actor, async (trx) => {
    const base = employeesInMonth(trx, orgId, from, to, { branchScope, departmentId: q.departmentId, employeeId: q.employeeId, search: q.search });
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const employees = await base.select(['e.id', 'e.employeeNumber', 'e.displayName', 'e.branchId', 'e.departmentId', 'e.joiningDate', 'e.exitDate'])
      .orderBy('e.displayName').orderBy('e.id').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute();
    const ids = employees.map((e) => e.id);
    const records = ids.length ? await trx.selectFrom('attendanceDailyRecords')
      .select(['id', 'employeeId', 'attendanceDate', 'status', 'flags', 'firstInAt', 'lastOutAt', 'workedMinutes', 'lateMinutes', 'earlyDepartureMinutes', 'overtimeMinutes', 'timezone'])
      .where('organizationId', '=', orgId).where('employeeId', 'in', ids).where('attendanceDate', '>=', dv(from)).where('attendanceDate', '<=', dv(to)).execute() : [];
    const manual = await manualOverrides(trx, orgId, ids, from, to);
    const tz = await orgTimezone(trx, orgId);
    const byEmployee = new Map<string, Record<string, AttendanceCalendarDayDto>>();
    for (const r of records) {
      const date = isoDate(r.attendanceDate);
      const map = byEmployee.get(r.employeeId) ?? {};
      map[date] = {
        recordId: r.id, status: r.status, flags: [...r.flags], statusSource: manual.has(`${r.employeeId}|${date}`) ? 'MANUAL' : 'AUTO',
        firstInAt: isoDateTimeOrNull(r.firstInAt), lastOutAt: isoDateTimeOrNull(r.lastOutAt), workedMinutes: r.workedMinutes, lateMinutes: r.lateMinutes,
        earlyDepartureMinutes: r.earlyDepartureMinutes, overtimeMinutes: r.overtimeMinutes, timezone: r.timezone,
      };
      byEmployee.set(r.employeeId, map);
    }
    const data = employees.map((e) => ({
      employeeId: e.id, employeeNumber: String(e.employeeNumber), employeeName: e.displayName, branchId: e.branchId, departmentId: e.departmentId,
      joiningDate: isoDate(e.joiningDate), exitDate: e.exitDate === null ? null : isoDate(e.exitDate), days: byEmployee.get(e.id) ?? {},
    }));
    return { data, total, meta: { month: q.month, days, today: DateTime.now().setZone(tz).toISODate()! } };
  });
}

// ---- monthly summary -----------------------------------------------------------------------------------------------------------

interface SummarySqlRow {
  employeeId: string; employeeNumber: string; employeeName: string; branchId: string; departmentId: string | null;
  presentDays: string | number; lateDays: number; halfDays: number; leaveDays: string | number; absentDays: string | number; missingPunchDays: number; holidayDays: number;
  weeklyOffDays: number; daysWorked: number; workedMinutes: string | number; overtimeMinutes: string | number; lopDays: string | number; unexcusedDays: number;
  pendingDays: number; recordCount: number; finalizedAt: Date | null;
}

/**
 * One row per employee employed during the month, computed in SQL from `attendance_daily_records` under the caller's RLS (so a
 * branch-scoped HR user gets their branches and a line manager their team) with the period summary's fractions (a half day is
 * 0.5 present + 0.5 leave or absent; see `summarisePeriod`). When the month's payroll period summary is FINALIZED and visible to
 * the caller (payroll.view), its day counts win — they are what payroll paid.
 */
function summaryRowsQuery(orgId: string, from: string, to: string, f: EmployeeFilter) {
  const like = f.search ? likeContains(f.search) : null;
  const scope = f.branchScope ? (f.branchScope.length ? f.branchScope : ['00000000-0000-0000-0000-000000000000']) : null;
  return sql`
    with emp as (
      select e.id, e.employee_number::text as employee_number, e.display_name, e.branch_id, e.department_id
      from public.employees e
      where e.organization_id = ${orgId}::uuid and e.deleted_at is null
        and e.joining_date <= ${to}::date and (e.exit_date is null or e.exit_date >= ${from}::date)
        and (${scope}::uuid[] is null or e.branch_id = any(${scope}::uuid[]))
        and (${f.departmentId ?? null}::uuid is null or e.department_id = ${f.departmentId ?? null}::uuid)
        and (${f.employeeId ?? null}::uuid is null or e.id = ${f.employeeId ?? null}::uuid)
        and (${like}::text is null or e.display_name ilike ${like}::text or e.employee_number::text ilike ${like}::text)
    ),
    rec as (
      select r.employee_id,
        count(*)::int as record_count,
        coalesce(sum(case when r.status in ('PRESENT', 'MISSING_PUNCH') then (case when 'HALF_DAY_LEAVE' = any(r.flags) then 0.5 else 1 end)
                          when r.status = 'HALF_DAY' then 0.5 else 0 end), 0)::numeric as present_days,
        (count(*) filter (where 'LATE' = any(r.flags)))::int as late_days,
        (count(*) filter (where r.status = 'HALF_DAY' or (r.status in ('PRESENT', 'MISSING_PUNCH') and 'HALF_DAY_LEAVE' = any(r.flags))))::int as half_days,
        coalesce(sum(case when r.status = 'LEAVE' then 1
                          when r.status in ('PRESENT', 'MISSING_PUNCH', 'HALF_DAY', 'ABSENT') and 'HALF_DAY_LEAVE' = any(r.flags) then 0.5 else 0 end), 0)::numeric as leave_days,
        coalesce(sum(case when r.status = 'ABSENT' then (case when 'HALF_DAY_LEAVE' = any(r.flags) then 0.5 else 1 end)
                          when r.status = 'HALF_DAY' and not ('HALF_DAY_LEAVE' = any(r.flags)) then 0.5 else 0 end), 0)::numeric as absent_days,
        (count(*) filter (where r.status = 'MISSING_PUNCH' or r.flags && array['MISSING_IN', 'MISSING_OUT']::text[]))::int as missing_punch_days,
        (count(*) filter (where r.status = 'HOLIDAY'))::int as holiday_days,
        (count(*) filter (where r.status = 'WEEKLY_OFF'))::int as weekly_off_days,
        (count(*) filter (where r.worked_minutes > 0))::int as days_worked,
        coalesce(sum(greatest(r.worked_minutes, 0)), 0)::bigint as worked_minutes,
        coalesce(sum(greatest(r.overtime_minutes, 0)), 0)::bigint as overtime_minutes,
        coalesce(sum(case when 'LOP' = any(r.flags) then (case when 'PAY_EFFECT_FULL' = any(r.flags) then 1 when 'PAY_EFFECT_HALF' = any(r.flags) then 0.5 else 0 end) else 0 end), 0)::numeric as lop_days,
        (count(*) filter (where 'UNEXCUSED' = any(r.flags)))::int as unexcused_days,
        (count(*) filter (where r.status = 'PENDING'))::int as pending_days
      from public.attendance_daily_records r
      where r.organization_id = ${orgId}::uuid and r.attendance_date between ${from}::date and ${to}::date and r.employee_id in (select id from emp)
      group by r.employee_id
    ),
    fin as (
      select distinct on (s.employee_id) s.employee_id, s.present_days, s.late_days, s.half_days, s.leave_days, s.absent_days, s.missing_punch_days, s.holiday_days, s.weekly_off_days,
        (s.regular_minutes + s.overtime_minutes + s.overtime_weekly_off_minutes + s.overtime_holiday_minutes)::bigint as worked_minutes,
        (s.overtime_minutes + s.overtime_weekly_off_minutes + s.overtime_holiday_minutes)::bigint as overtime_minutes,
        s.lop_days, s.unexcused_days, s.finalized_at
      from public.attendance_period_summaries s
      where s.organization_id = ${orgId}::uuid and s.period_start = ${from}::date and s.period_end = ${to}::date and s.status = 'finalized'
        and s.employee_id in (select id from emp)
      order by s.employee_id, s.version desc
    )
    select emp.id as "employeeId", emp.employee_number as "employeeNumber", emp.display_name as "employeeName", emp.branch_id as "branchId", emp.department_id as "departmentId",
      coalesce(fin.present_days, rec.present_days, 0) as "presentDays", coalesce(fin.late_days, rec.late_days, 0) as "lateDays", coalesce(fin.half_days, rec.half_days, 0) as "halfDays",
      coalesce(fin.leave_days, rec.leave_days, 0) as "leaveDays", coalesce(fin.absent_days, rec.absent_days, 0) as "absentDays",
      coalesce(fin.missing_punch_days, rec.missing_punch_days, 0) as "missingPunchDays", coalesce(fin.holiday_days, rec.holiday_days, 0) as "holidayDays",
      coalesce(fin.weekly_off_days, rec.weekly_off_days, 0) as "weeklyOffDays", coalesce(rec.days_worked, 0) as "daysWorked",
      coalesce(fin.worked_minutes, rec.worked_minutes, 0) as "workedMinutes", coalesce(fin.overtime_minutes, rec.overtime_minutes, 0) as "overtimeMinutes",
      coalesce(fin.lop_days, rec.lop_days, 0) as "lopDays", coalesce(fin.unexcused_days, rec.unexcused_days, 0) as "unexcusedDays",
      coalesce(rec.pending_days, 0) as "pendingDays", coalesce(rec.record_count, 0) as "recordCount", fin.finalized_at as "finalizedAt"
    from emp left join rec on rec.employee_id = emp.id left join fin on fin.employee_id = emp.id`;
}

const num = (v: string | number | null | undefined): number => { const n = typeof v === 'number' ? v : Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

function toFigures(r: SummarySqlRow): AttendanceSummaryFigures {
  const daysWorked = num(r.daysWorked);
  const workedMinutes = num(r.workedMinutes);
  return {
    presentDays: num(r.presentDays), lateDays: num(r.lateDays), halfDays: num(r.halfDays), leaveDays: num(r.leaveDays), absentDays: num(r.absentDays),
    missingPunchDays: num(r.missingPunchDays), holidayDays: num(r.holidayDays), weeklyOffDays: num(r.weeklyOffDays), daysWorked, workedMinutes,
    overtimeMinutes: num(r.overtimeMinutes), averageWorkedMinutes: daysWorked > 0 ? Math.round(workedMinutes / daysWorked) : 0, lopDays: num(r.lopDays),
    unexcusedDays: num(r.unexcusedDays), pendingDays: num(r.pendingDays), recordCount: num(r.recordCount),
  };
}

function sumFigures(rows: readonly AttendanceSummaryFigures[]): AttendanceSummaryFigures {
  const total: AttendanceSummaryFigures = { presentDays: 0, lateDays: 0, halfDays: 0, leaveDays: 0, absentDays: 0, missingPunchDays: 0, holidayDays: 0, weeklyOffDays: 0, daysWorked: 0, workedMinutes: 0, overtimeMinutes: 0, averageWorkedMinutes: 0, lopDays: 0, unexcusedDays: 0, pendingDays: 0, recordCount: 0 };
  for (const r of rows) {
    for (const k of Object.keys(total) as Array<keyof AttendanceSummaryFigures>) if (k !== 'averageWorkedMinutes') total[k] += r[k];
  }
  total.averageWorkedMinutes = total.daysWorked > 0 ? Math.round(total.workedMinutes / total.daysWorked) : 0;
  return total;
}

async function summaryRows(trx: Trx, orgId: string, q: AttendanceSummaryExportQuery, branchScope: string[] | null, page: { limit: number; offset: number } | null): Promise<{ rows: AttendanceSummaryRowDto[]; all: AttendanceSummaryFigures[] }> {
  const { from, to } = monthRange(q.month);
  const base = summaryRowsQuery(orgId, from, to, { branchScope, departmentId: q.departmentId, employeeId: q.employeeId, search: q.search });
  const all = (await sql<SummarySqlRow>`${base} order by "employeeName", "employeeId"`.execute(trx)).rows;
  const slice = page ? all.slice(page.offset, page.offset + page.limit) : all;
  const names = await namesOf(trx, orgId, [...new Set(slice.map((r) => r.branchId))], [...new Set(slice.map((r) => r.departmentId).filter((d): d is string => d !== null))]);
  const rows = slice.map((r) => ({
    ...toFigures(r), employeeId: r.employeeId, employeeNumber: r.employeeNumber, employeeName: r.employeeName, branchId: r.branchId, branchName: names.branches.get(r.branchId) ?? null,
    departmentId: r.departmentId, departmentName: r.departmentId ? names.departments.get(r.departmentId) ?? null : null,
    source: r.finalizedAt ? 'FINALIZED' as const : 'LIVE' as const, finalizedAt: isoDateTimeOrNull(r.finalizedAt),
  }));
  return { rows, all: all.map(toFigures) };
}

/** GET /attendance/summary — the monthly summary page (paged rows + the totals of the whole filtered set). */
export async function summary(deps: ApiDeps, actor: Actor, orgId: string, q: AttendanceSummaryQuery): Promise<{ data: AttendanceSummaryRowDto[]; total: number; meta: { month: string; from: string; to: string; totals: AttendanceSummaryFigures } }> {
  const { branchScope } = readScope(actor, orgId, q.branchId);
  const { from, to } = monthRange(q.month);
  return runUser(deps.db, actor, async (trx) => {
    const res = await summaryRows(trx, orgId, q, branchScope, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return { data: res.rows, total: res.all.length, meta: { month: q.month, from, to, totals: sumFigures(res.all) } };
  });
}

/** Spreadsheet formula injection guard (AGENTS.md exports rule): text starting with = + - @ tab CR is prefixed with an apostrophe. */
export function escapeSpreadsheetText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

const hours = (minutes: number): string => (minutes / 60).toFixed(2);

/**
 * GET /attendance/summary/export — the same figures as CSV (UTF-8 with BOM, formula-safe cells, a TOTAL row). Gated by
 * report.export (declared for exactly this, enforced here), counted against an hourly organisation quota and audited with the
 * row count. The file is built synchronously: it is bounded by ATTENDANCE_SUMMARY_EXPORT_MAX_ROWS employees.
 */
export async function exportSummary(deps: ApiDeps, actor: Actor, orgId: string, q: AttendanceSummaryExportQuery): Promise<AttendanceSummaryExportDto> {
  const { grant, branchScope } = readScope(actor, orgId, q.branchId);
  if (!hasPermission(grant, 'report.export')) throw errors.forbidden('Missing permission: report.export.');
  return runUser(deps.db, actor, async (trx) => {
    const res = await summaryRows(trx, orgId, q, branchScope, null);
    if (res.rows.length > ATTENDANCE_SUMMARY_EXPORT_MAX_ROWS) throw errors.validation(`The export is limited to ${ATTENDANCE_SUMMARY_EXPORT_MAX_ROWS} employees; filter by branch or department.`, { rows: res.rows.length });
    await systemStep(trx, orgId, (t) => consumeQuota(t, orgId, 'attendance_summary_exports', SUMMARY_EXPORTS_PER_HOUR));
    const header = ['Employee No.', 'Employee', 'Branch', 'Department', 'Present', 'Late', 'Half day', 'On leave', 'Absent', 'Missed punch', 'Holidays', 'Weekly offs', 'Days worked', 'Worked hours', 'Overtime hours', 'Avg hours/day', 'LOP days', 'Unexcused days', 'Source'];
    const line = (cells: Array<string | number>) => toCsvLine(cells.map((c) => (typeof c === 'number' ? c : escapeSpreadsheetText(c))));
    const lines = [line(header)];
    for (const r of res.rows) {
      lines.push(line([r.employeeNumber, r.employeeName, r.branchName ?? '', r.departmentName ?? '', r.presentDays, r.lateDays, r.halfDays, r.leaveDays, r.absentDays, r.missingPunchDays, r.holidayDays, r.weeklyOffDays, r.daysWorked, hours(r.workedMinutes), hours(r.overtimeMinutes), hours(r.averageWorkedMinutes), r.lopDays, r.unexcusedDays, r.source]));
    }
    const t = sumFigures(res.all);
    lines.push(line(['', 'TOTAL', '', '', t.presentDays, t.lateDays, t.halfDays, t.leaveDays, t.absentDays, t.missingPunchDays, t.holidayDays, t.weeklyOffDays, t.daysWorked, hours(t.workedMinutes), hours(t.overtimeMinutes), hours(t.averageWorkedMinutes), t.lopDays, t.unexcusedDays, '']));
    await audit(trx, actor, orgId, 'attendance.summary_exported', 'attendance_daily_record', { branchId: q.branchId ?? null, newValue: { month: q.month, rowCount: res.rows.length, filters: { branchId: q.branchId ?? null, departmentId: q.departmentId ?? null, employeeId: q.employeeId ?? null, search: q.search ?? null } } });
    // UTF-8 byte order mark first, so Excel opens Arabic names correctly
    return { fileName: `attendance-summary-${q.month}.csv`, contentType: 'text/csv', content: `\uFEFF${lines.join('\r\n')}\r\n`, rowCount: res.rows.length };
  });
}

// ---- punch timeline -----------------------------------------------------------------------------------------------------------------

const FACT_STRING = /^[\w .:/-]{1,64}$/;
/** Allow-listed self-service / connector facts of a raw payload (never the whole payload). */
export function punchFactsOf(raw: unknown): PunchFactsDto {
  const o = jsonObject(raw);
  const out: PunchFactsDto = {};
  const str = (...keys: string[]) => { for (const k of keys) { const v = o[k]; if (typeof v === 'string' && FACT_STRING.test(v)) return v; } return undefined; };
  const numOf = (...keys: string[]) => { for (const k of keys) { const v = o[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; } return undefined; };
  const channel = str('channel'); if (channel) out.channel = channel;
  const verdict = str('geofenceVerdict', 'geofence_verdict', 'verdict'); if (verdict) out.geofenceVerdict = verdict;
  const geofenceId = str('geofenceId', 'geofence_id'); if (geofenceId) out.geofenceId = geofenceId;
  const distance = numOf('distanceM', 'distance_m', 'distance'); if (distance !== undefined) out.distanceM = distance;
  const lat = numOf('lat', 'latitude'); if (lat !== undefined) out.lat = lat;
  const lng = numOf('lng', 'lon', 'longitude'); if (lng !== undefined) out.lng = lng;
  const accuracy = numOf('accuracy', 'accuracyM', 'accuracy_m'); if (accuracy !== undefined) out.accuracy = accuracy;
  if (o['isMock'] === true || o['is_mock'] === true) out.isMock = true;
  if (o['outOfWindow'] === true || o['out_of_window'] === true) out.outOfWindow = true;
  return out;
}

/** GET /attendance/timeline — the normalised events of an employee's day (+ the raw device rows for attendance.view_raw). */
export async function timeline(deps: ApiDeps, actor: Actor, orgId: string, q: AttendanceTimelineQuery): Promise<AttendanceTimelineDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  const withRaw = hasPermission(grant, 'attendance.view_raw');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await trx.selectFrom('employees').select(['id', 'employeeNumber', 'displayName', 'branchId', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', q.employeeId).executeTakeFirst();
    if (!emp) throw errors.notFound('Employee', q.employeeId);
    requireBranchAccess(grant, emp.branchId);
    const record = await trx.selectFrom('attendanceDailyRecords').select(['id', 'status', 'timezone', sql<unknown>`trace -> 'punches'`.as('punches')])
      .where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('attendanceDate', '=', dv(q.date)).executeTakeFirst();
    const tz = record?.timezone ?? (await withSystemScope(trx, orgId, (t) => t.selectFrom('branches').select('timezone').where('organizationId', '=', orgId).where('id', '=', emp.branchId).executeTakeFirst()))?.timezone ?? 'UTC';
    const zone = DateTime.now().setZone(tz).isValid ? tz : 'UTC';
    const from = DateTime.fromISO(q.date, { zone }).minus({ days: 1 }).startOf('day').toJSDate();
    const to = DateTime.fromISO(q.date, { zone }).plus({ days: 2 }).startOf('day').toJSDate();
    const roles = new Map<string, string>();
    if (record && Array.isArray(record.punches)) for (const p of record.punches as Array<{ eventId?: unknown; role?: unknown }>) if (typeof p.eventId === 'string' && typeof p.role === 'string') roles.set(p.eventId, p.role);
    const events = await trx.selectFrom('attendanceEvents').select(['id', 'punchedAt', 'eventType', 'source', 'verificationMethod', 'deviceId', 'voidedAt', 'voidedByCorrectionId', 'correctionId', 'note', 'rawTransactionId'])
      .where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('punchedAt', '>=', from).where('punchedAt', '<', to).orderBy('punchedAt').orderBy('id').limit(TIMELINE_RAW_LIMIT).execute();
    const raw = withRaw ? await trx.selectFrom('attendanceRawTransactions').select(['id', 'punchedAt', 'deviceId', 'deviceEmployeeId', 'direction', 'verificationMethod', 'source', 'processingStatus', 'processingError', 'receivedAt', 'deviceLocalTime', 'clockSkewSeconds', 'rawPayload'])
      .where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('punchedAt', '>=', from).where('punchedAt', '<', to).orderBy('punchedAt').orderBy('id').limit(TIMELINE_RAW_LIMIT).execute() : null;
    const deviceIds = [...new Set([...events.map((e) => e.deviceId), ...(raw ?? []).map((r) => r.deviceId)].filter((d): d is string => d !== null))];
    const deviceNames = deviceIds.length ? new Map((await withSystemScope(trx, orgId, (t) => t.selectFrom('devices').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', deviceIds).execute())).map((d) => [d.id, d.name])) : new Map<string, string>();
    return {
      employeeId: emp.id, employeeNumber: String(emp.employeeNumber), employeeName: emp.displayName, date: q.date, timezone: zone, recordId: record?.id ?? null, status: record?.status ?? null,
      window: { from: from.toISOString(), to: to.toISOString() },
      events: events.map((e) => ({
        id: e.id, punchedAt: isoDateTime(e.punchedAt), eventType: e.eventType, source: e.source, verificationMethod: e.verificationMethod, deviceId: e.deviceId, deviceName: e.deviceId ? deviceNames.get(e.deviceId) ?? null : null,
        voidedAt: isoDateTimeOrNull(e.voidedAt), voidedByCorrectionId: e.voidedByCorrectionId, correctionId: e.correctionId, note: e.note,
        rawTransactionId: e.rawTransactionId === null ? null : String(e.rawTransactionId), role: roles.get(e.id) ?? null,
      })),
      raw: raw ? raw.map((r): TimelineRawDto => ({
        id: String(r.id), punchedAt: isoDateTime(r.punchedAt), deviceId: r.deviceId, deviceName: deviceNames.get(r.deviceId) ?? null, deviceEmployeeId: r.deviceEmployeeId,
        direction: r.direction, verificationMethod: r.verificationMethod, source: r.source, processingStatus: r.processingStatus, processingError: r.processingError,
        receivedAt: isoDateTime(r.receivedAt), deviceLocalTime: r.deviceLocalTime, clockSkewSeconds: r.clockSkewSeconds, facts: punchFactsOf(r.rawPayload),
      })) : null,
    };
  });
}

// ---- unmatched punch triage ----------------------------------------------------------------------------------------------------------

interface UnmatchedGroupRow { deviceId: string; deviceEmployeeId: string; status: string; count: number | string; firstPunchAt: Date; lastPunchAt: Date; lastReceivedAt: Date; branchId: string | null }

/** Devices a branch-restricted caller may triage (raw rows without a branch take the device's). Null = every device. */
async function triageDeviceScope(trx: Trx, orgId: string, grant: MembershipGrant): Promise<{ ids: string[]; devices: Map<string, { id: string; name: string; code: string | null; providerKey: string; branchId: string | null }> }> {
  const devices = await withSystemScope(trx, orgId, (t) => t.selectFrom('devices').select(['id', 'name', 'code', 'providerKey', 'branchId']).where('organizationId', '=', orgId).execute());
  const visible = grant.allBranches ? devices : devices.filter((d) => d.branchId !== null && grant.branchIds.includes(d.branchId));
  return { ids: visible.map((d) => d.id), devices: new Map(devices.map((d) => [d.id, { id: d.id, name: d.name, code: d.code ?? null, providerKey: d.providerKey, branchId: d.branchId }])) };
}

/**
 * GET /attendance/unmatched — raw punches the normaliser could not attribute, grouped by (device, device user id) with count and
 * first / last seen; `status=ignored` lists what was set aside (last 180 days). Suggestions: employees whose device user id or
 * employee number equals the device user id.
 */
export async function listUnmatched(deps: ApiDeps, actor: Actor, orgId: string, q: UnmatchedPunchesQuery): Promise<{ data: UnmatchedPunchGroupDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view_raw');
  requireBranchAccess(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const scope = await triageDeviceScope(trx, orgId, grant);
    let deviceIds = q.branchId ? scope.ids.filter((id) => scope.devices.get(id)?.branchId === q.branchId) : scope.ids;
    if (q.deviceId) deviceIds = deviceIds.filter((id) => id === q.deviceId);
    if (deviceIds.length === 0) return { data: [], total: 0 };
    const since = q.status === 'ignored' ? new Date(Date.now() - IGNORED_LOOKBACK_DAYS * 86_400_000) : null;
    const like = q.search ? likeContains(q.search) : null;
    const where = sql`t.organization_id = ${orgId}::uuid and t.processing_status = ${q.status}::public.raw_processing_status and t.device_id = any(${deviceIds}::uuid[])
      and (${since}::timestamptz is null or t.punched_at >= ${since}::timestamptz) and (${like}::text is null or t.device_employee_id ilike ${like}::text)`;
    const total = toCount((await sql<{ n: string }>`select count(*) as n from (select 1 from public.attendance_raw_transactions t where ${where} group by t.device_id, t.device_employee_id) g`.execute(trx)).rows[0]?.n);
    const offset = (q.page - 1) * q.pageSize;
    const groups = (await sql<UnmatchedGroupRow>`
      select t.device_id as "deviceId", t.device_employee_id as "deviceEmployeeId", ${q.status}::text as status, count(*) as count,
        min(t.punched_at) as "firstPunchAt", max(t.punched_at) as "lastPunchAt", max(t.received_at) as "lastReceivedAt", max(t.branch_id::text)::uuid as "branchId"
      from public.attendance_raw_transactions t where ${where}
      group by t.device_id, t.device_employee_id
      order by max(t.received_at) desc, t.device_id, t.device_employee_id
      limit ${q.pageSize} offset ${offset}`.execute(trx)).rows;
    const userIds = [...new Set(groups.map((g) => g.deviceEmployeeId))];
    const candidates = userIds.length ? await trx.selectFrom('employees').select(['id', 'employeeNumber', 'displayName', 'deviceUserId'])
      .where('organizationId', '=', orgId).where('deletedAt', 'is', null)
      .where((eb) => eb.or([eb('deviceUserId', 'in', userIds), eb(sql`employee_number::text`, 'in', userIds)])).limit(500).execute() : [];
    const branchIds = [...new Set(groups.map((g) => g.branchId ?? scope.devices.get(g.deviceId)?.branchId ?? null).filter((b): b is string => b !== null))];
    const names = await namesOf(trx, orgId, branchIds, []);
    const data = groups.map((g): UnmatchedPunchGroupDto => {
      const device = scope.devices.get(g.deviceId);
      const branchId = g.branchId ?? device?.branchId ?? null;
      const suggestions: UnmatchedSuggestionDto[] = [];
      for (const c of candidates) {
        if (suggestions.length >= 3) break;
        if (c.deviceUserId === g.deviceEmployeeId) suggestions.push({ employeeId: c.id, employeeNumber: String(c.employeeNumber), displayName: c.displayName, reason: 'device_user_id' });
        else if (String(c.employeeNumber) === g.deviceEmployeeId) suggestions.push({ employeeId: c.id, employeeNumber: String(c.employeeNumber), displayName: c.displayName, reason: 'employee_number' });
      }
      return {
        deviceId: g.deviceId, deviceName: device?.name ?? null, deviceCode: device?.code ?? null, providerKey: device?.providerKey ?? '', branchId, branchName: branchId ? names.branches.get(branchId) ?? null : null,
        deviceEmployeeId: g.deviceEmployeeId, status: q.status, count: toCount(g.count), firstPunchAt: isoDateTime(g.firstPunchAt), lastPunchAt: isoDateTime(g.lastPunchAt), lastReceivedAt: isoDateTime(g.lastReceivedAt), suggestions,
      };
    });
    return { data, total };
  });
}

async function triageDevice(trx: Trx, orgId: string, grant: MembershipGrant, deviceId: string): Promise<{ id: string; branchId: string | null; providerKey: string }> {
  const scope = await triageDeviceScope(trx, orgId, grant);
  const device = scope.devices.get(deviceId);
  if (!device || !scope.ids.includes(deviceId)) throw errors.notFound('Device', deviceId);
  return device;
}

async function requeueNormalize(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, rows: number): Promise<string | null> {
  if (rows === 0) return null;
  return enqueueJob(deps.queue, trx, { queue: 'processing', jobType: 'NORMALIZE_RAW', organizationId: orgId, payload: { organizationId: orgId }, dedupeKey: `normalize:${orgId}`, correlationId: actor.requestId, priority: 6 });
}

/**
 * POST /attendance/unmatched/assign — map a device user id to an employee on that device and re-queue its unmatched rows.
 * Writes the row the normaliser reads FIRST (`device_employee_states`, before provider identities and employees.device_user_id;
 * for Flowza Finance connectors right after the connector's own resolver), so the next normaliser run attributes the punches.
 * A device user id already mapped to someone else, or an employee already mapped to another id on the device, is a conflict —
 * never silently re-pointed. The mapping is `desired` (the person belongs on the device under this id).
 */
export async function assignUnmatched(deps: ApiDeps, actor: Actor, orgId: string, input: UnmatchedAssignInput): Promise<UnmatchedActionResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view_raw', 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const device = await triageDevice(trx, orgId, grant, input.deviceId);
    const emp = await trx.selectFrom('employees').select(['id', 'branchId', 'displayName', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', input.employeeId).executeTakeFirst();
    if (!emp || emp.deletedAt) throw errors.validation('Employee not found.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
    requireBranchAccess(grant, emp.branchId);
    const res = await systemStep(trx, orgId, async (t) => {
      const states = await t.selectFrom('deviceEmployeeStates').select(['id', 'employeeId', 'deviceUserId']).where('organizationId', '=', orgId).where('deviceId', '=', device.id)
        .where((eb) => eb.or([eb('deviceUserId', '=', input.deviceEmployeeId), eb('employeeId', '=', emp.id)])).execute();
      const byUser = states.find((s) => s.deviceUserId === input.deviceEmployeeId);
      const byEmployee = states.find((s) => s.employeeId === emp.id);
      if (byUser?.employeeId && byUser.employeeId !== emp.id) throw errors.conflict('This device user is already mapped to another employee on the device.', { employeeId: byUser.employeeId });
      if (byEmployee && byEmployee.deviceUserId !== input.deviceEmployeeId) throw errors.conflict(`The employee is already mapped to device user ${byEmployee.deviceUserId} on this device.`, { deviceUserId: byEmployee.deviceUserId });
      let created = false;
      if (!byUser) {
        await t.insertInto('deviceEmployeeStates').values({ organizationId: orgId, deviceId: device.id, branchId: device.branchId, deviceUserId: input.deviceEmployeeId, employeeId: emp.id, desired: true, syncStatus: 'IN_SYNC', lastSyncAt: new Date() }).execute();
        created = true;
      } else if (!byUser.employeeId) {
        await t.updateTable('deviceEmployeeStates').set({ employeeId: emp.id, desired: true }).where('id', '=', byUser.id).execute();
      }
      const moved = await sql`update public.attendance_raw_transactions set processing_status = 'pending', processing_error = null, processed_at = null
        where organization_id = ${orgId}::uuid and device_id = ${device.id}::uuid and device_employee_id = ${input.deviceEmployeeId} and processing_status = 'unmatched'`.execute(t);
      const rows = Number(moved.numAffectedRows ?? 0n);
      const jobId = await requeueNormalize(deps, t, actor, orgId, rows);
      return { created, rows, jobId };
    });
    await audit(trx, actor, orgId, 'attendance.unmatched_assigned', 'device_employee_state', {
      entityId: `${device.id}:${input.deviceEmployeeId}`, branchId: device.branchId,
      newValue: { deviceId: device.id, deviceEmployeeId: input.deviceEmployeeId, employeeId: emp.id, mappingCreated: res.created, rowsRequeued: res.rows, jobId: res.jobId },
    });
    return { deviceId: device.id, deviceEmployeeId: input.deviceEmployeeId, rows: res.rows, employeeId: emp.id, jobId: res.jobId };
  });
}

/** POST /attendance/unmatched/ignore — set a device user's unmatched rows aside (`ignored`; raw stays, only its bookkeeping moves). */
export async function ignoreUnmatched(deps: ApiDeps, actor: Actor, orgId: string, input: UnmatchedIgnoreInput): Promise<UnmatchedActionResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view_raw', 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const device = await triageDevice(trx, orgId, grant, input.deviceId);
    const rows = await systemStep(trx, orgId, async (t) => {
      const res = await sql`update public.attendance_raw_transactions set processing_status = 'ignored', processing_error = ${`Ignored: ${input.reason}`.slice(0, 500)}, processed_at = now()
        where organization_id = ${orgId}::uuid and device_id = ${device.id}::uuid and device_employee_id = ${input.deviceEmployeeId} and processing_status = 'unmatched'`.execute(t);
      return Number(res.numAffectedRows ?? 0n);
    });
    if (rows === 0) throw errors.invalidState('There are no unmatched punches for this device user.');
    await audit(trx, actor, orgId, 'attendance.raw_ignored', 'attendance_raw_transaction', { entityId: `${device.id}:${input.deviceEmployeeId}`, branchId: device.branchId, oldValue: { processingStatus: 'unmatched' }, newValue: { processingStatus: 'ignored', rowCount: rows, deviceId: device.id, deviceEmployeeId: input.deviceEmployeeId }, reason: input.reason });
    return { deviceId: device.id, deviceEmployeeId: input.deviceEmployeeId, rows };
  });
}

/** POST /attendance/unmatched/restore — put ignored rows back to the normaliser (they become unmatched again if still unknown). */
export async function restoreUnmatched(deps: ApiDeps, actor: Actor, orgId: string, input: UnmatchedRestoreInput): Promise<UnmatchedActionResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view_raw', 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const device = await triageDevice(trx, orgId, grant, input.deviceId);
    const res = await systemStep(trx, orgId, async (t) => {
      const moved = await sql`update public.attendance_raw_transactions set processing_status = 'pending', processing_error = null, processed_at = null
        where organization_id = ${orgId}::uuid and device_id = ${device.id}::uuid and device_employee_id = ${input.deviceEmployeeId} and processing_status = 'ignored'`.execute(t);
      const rows = Number(moved.numAffectedRows ?? 0n);
      return { rows, jobId: await requeueNormalize(deps, t, actor, orgId, rows) };
    });
    if (res.rows === 0) throw errors.invalidState('There are no ignored punches for this device user.');
    await audit(trx, actor, orgId, 'attendance.raw_restored', 'attendance_raw_transaction', { entityId: `${device.id}:${input.deviceEmployeeId}`, branchId: device.branchId, oldValue: { processingStatus: 'ignored' }, newValue: { processingStatus: 'pending', rowCount: res.rows, jobId: res.jobId } });
    return { deviceId: device.id, deviceEmployeeId: input.deviceEmployeeId, rows: res.rows, jobId: res.jobId };
  });
}
