import { sql } from 'kysely';
import type { AttendanceFlag, AttendanceStatus } from '@flowza/contracts';
import { event } from '@flowza/shared';
import { bypassPeriodLock, emitDomainEvent, withContext, type RecordHistoryReason, type Trx } from '@flowza/database';
import { calculateDailyRecord, type DailyCalculationResult } from '@flowza/domain';
import type { HandlerRegistry, JobContext } from '../types.js';
import { asDate, parsePayload, recomputePayloadSchema } from './common.js';
import { loadDailyInputs } from './load-inputs.js';

export interface RecomputeOptions {
  organizationId: string;
  employeeId: string;
  date: string;
  now: Date;
  reason: RecordHistoryReason;
  /** Recompute inside a locked period (unlock / explicit recalculation flows only). */
  bypassLock?: boolean;
  jobId?: string | null;
  triggeredBy?: string | null;
}

export type RecomputeOutcomeKind = 'created' | 'updated' | 'unchanged' | 'skipped_locked' | 'skipped_missing';
export interface RecomputeOutcome { outcome: RecomputeOutcomeKind; recordId?: string; version?: number; status?: AttendanceStatus; branchId?: string }

/** Is `date` inside an active period lock for the branch (or the whole organisation)? */
export async function isPeriodLocked(trx: Trx, organizationId: string, branchId: string, date: string): Promise<boolean> {
  const res = await sql<{ locked: boolean }>`select app.is_period_locked(${organizationId}::uuid, ${branchId}::uuid, ${date}::date) as locked`.execute(trx);
  return res.rows[0]?.locked === true;
}

/** The fields whose change means "the record changed" (trace and computed_at are excluded: they differ on every run). */
interface Comparable {
  branchId: string; departmentId: string | null; shiftId: string | null; shiftAssignmentId: string | null; ruleSetId: string | null; timezone: string;
  expectedStartAt: string | null; expectedEndAt: string | null; scheduledMinutes: number; firstInAt: string | null; lastOutAt: string | null;
  workedMinutes: number; breakMinutes: number; lateMinutes: number; earlyDepartureMinutes: number; overtimeMinutes: number; overtimeCategory: string | null;
  status: AttendanceStatus; flags: string[]; punchCount: number; hasCorrection: boolean; engineVersion: string;
}
const ts = (v: Date | string | null): string | null => (v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString());

/**
 * Recompute one (employee, date) from the database: load inputs → pure engine → upsert `attendance_daily_records`.
 * Idempotent: identical inputs produce no version bump, no history row and no domain event. A changed result bumps
 * `calculation_version`, snapshots the previous row into `attendance_daily_record_history` with `reason`, and emits
 * `attendance.created` / `attendance.updated`. Records inside a locked period are skipped unless `bypassLock`.
 */
export async function recomputeDaily(trx: Trx, opts: RecomputeOptions): Promise<RecomputeOutcome> {
  const { organizationId, employeeId, date } = opts;
  const loaded = await loadDailyInputs(trx, organizationId, employeeId, date, opts.now);
  if (!loaded) return { outcome: 'skipped_missing' };

  const existing = await trx.selectFrom('attendanceDailyRecords').selectAll()
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).where('attendanceDate', '=', asDate(date)).executeTakeFirst();

  // Lock check on the new branch and, when the record moves branches, on the old one too.
  const branchesToCheck = [...new Set([loaded.branchId, ...(existing ? [existing.branchId] : [])])];
  let locked = false;
  for (const b of branchesToCheck) if (await isPeriodLocked(trx, organizationId, b, date)) { locked = true; break; }
  if (locked) {
    if (!opts.bypassLock) return { outcome: 'skipped_locked', branchId: loaded.branchId, ...(existing ? { recordId: existing.id, version: existing.calculationVersion, status: existing.status } : {}) };
    await bypassPeriodLock(trx);
  }

  const result = calculateDailyRecord(loaded.input);
  const { status, flags, hasCorrection } = await applyManualOverride(trx, organizationId, employeeId, date, result, loaded.eventSources);

  const next: Comparable = {
    branchId: loaded.branchId, departmentId: loaded.departmentId, shiftId: result.shiftId, shiftAssignmentId: result.shiftAssignmentId, ruleSetId: result.ruleSetId, timezone: result.timezone,
    expectedStartAt: ts(result.expectedStartAt), expectedEndAt: ts(result.expectedEndAt), scheduledMinutes: result.scheduledMinutes, firstInAt: ts(result.firstInAt), lastOutAt: ts(result.lastOutAt),
    workedMinutes: result.workedMinutes, breakMinutes: result.breakMinutes, lateMinutes: result.lateMinutes, earlyDepartureMinutes: result.earlyDepartureMinutes, overtimeMinutes: result.overtimeMinutes, overtimeCategory: result.overtimeCategory,
    status, flags, punchCount: result.punchCount, hasCorrection, engineVersion: result.trace.engineVersion,
  };
  const columns = {
    branchId: next.branchId, departmentId: next.departmentId, shiftId: next.shiftId, shiftAssignmentId: next.shiftAssignmentId, ruleSetId: next.ruleSetId, timezone: next.timezone,
    expectedStartAt: result.expectedStartAt ? new Date(result.expectedStartAt) : null, expectedEndAt: result.expectedEndAt ? new Date(result.expectedEndAt) : null, scheduledMinutes: next.scheduledMinutes,
    firstInAt: result.firstInAt ? new Date(result.firstInAt) : null, lastOutAt: result.lastOutAt ? new Date(result.lastOutAt) : null,
    workedMinutes: next.workedMinutes, breakMinutes: next.breakMinutes, lateMinutes: next.lateMinutes, earlyDepartureMinutes: next.earlyDepartureMinutes, overtimeMinutes: next.overtimeMinutes, overtimeCategory: next.overtimeCategory,
    status: next.status, flags: next.flags, punchCount: next.punchCount, hasCorrection: next.hasCorrection, engineVersion: next.engineVersion, trace: JSON.stringify(result.trace), computedAt: opts.now,
  };
  const eventPayload = { employeeId, date, status: next.status, flags: next.flags, branchId: next.branchId };

  if (!existing) {
    const inserted = await trx.insertInto('attendanceDailyRecords').values({ organizationId, employeeId, attendanceDate: date, calculationVersion: 1, ...columns }).returning('id').executeTakeFirstOrThrow();
    await emitDomainEvent(trx, { organizationId, eventType: 'attendance.created', aggregateType: 'attendance_daily_record', aggregateId: inserted.id, payload: eventPayload, actorUserId: opts.triggeredBy ?? null });
    return { outcome: 'created', recordId: inserted.id, version: 1, status: next.status, branchId: next.branchId };
  }

  const previous: Comparable = {
    branchId: existing.branchId, departmentId: existing.departmentId, shiftId: existing.shiftId, shiftAssignmentId: existing.shiftAssignmentId, ruleSetId: existing.ruleSetId, timezone: existing.timezone,
    expectedStartAt: ts(existing.expectedStartAt), expectedEndAt: ts(existing.expectedEndAt), scheduledMinutes: existing.scheduledMinutes, firstInAt: ts(existing.firstInAt), lastOutAt: ts(existing.lastOutAt),
    workedMinutes: existing.workedMinutes, breakMinutes: existing.breakMinutes, lateMinutes: existing.lateMinutes, earlyDepartureMinutes: existing.earlyDepartureMinutes, overtimeMinutes: existing.overtimeMinutes, overtimeCategory: existing.overtimeCategory,
    status: existing.status, flags: existing.flags, punchCount: existing.punchCount, hasCorrection: existing.hasCorrection, engineVersion: existing.engineVersion,
  };
  if (JSON.stringify(previous) === JSON.stringify(next)) return { outcome: 'unchanged', recordId: existing.id, version: existing.calculationVersion, status: existing.status, branchId: existing.branchId };

  const version = existing.calculationVersion + 1;
  await trx.insertInto('attendanceDailyRecordHistory').values({
    organizationId, recordId: existing.id, employeeId, branchId: existing.branchId, attendanceDate: date, calculationVersion: existing.calculationVersion,
    reason: opts.reason, snapshot: JSON.stringify(snapshotOf(existing)), triggeredBy: opts.triggeredBy ?? null, jobId: opts.jobId ?? null,
  }).execute();
  await trx.updateTable('attendanceDailyRecords').set({ ...columns, calculationVersion: version }).where('id', '=', existing.id).execute();
  await emitDomainEvent(trx, { organizationId, eventType: 'attendance.updated', aggregateType: 'attendance_daily_record', aggregateId: existing.id, payload: { ...eventPayload, previousStatus: existing.status, version, reason: opts.reason }, actorUserId: opts.triggeredBy ?? null });
  return { outcome: 'updated', recordId: existing.id, version, status: next.status, branchId: next.branchId };
}

/** JSON-safe copy of the previous row for the history snapshot. */
function snapshotOf(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

/**
 * An applied SET_STATUS correction overrides the computed status (the engine result stays in the trace). The override is
 * re-applied on every recompute so the record remains reproducible from raw + corrections.
 */
async function applyManualOverride(trx: Trx, organizationId: string, employeeId: string, date: string, result: DailyCalculationResult, eventSources: Map<string, 'DEVICE' | 'MANUAL' | 'CORRECTION' | 'IMPORT' | 'MOBILE'>): Promise<{ status: AttendanceStatus; flags: AttendanceFlag[]; hasCorrection: boolean }> {
  let hasCorrection = result.eventIds.some((id) => { const s = eventSources.get(id); return s === 'CORRECTION' || s === 'MANUAL'; });
  let status = result.status;
  const flags = new Set<AttendanceFlag>(result.flags);
  const override = await trx.selectFrom('attendanceCorrections').select(['id', 'proposedStatus', 'appliedAt'])
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).where('attendanceDate', '=', asDate(date))
    .where('type', '=', 'SET_STATUS').where('status', '=', 'APPLIED').where('proposedStatus', 'is not', null)
    .orderBy('appliedAt', 'desc').orderBy('id', 'desc').executeTakeFirst();
  if (override?.proposedStatus) {
    status = override.proposedStatus;
    flags.add('MANUAL_CORRECTION');
    hasCorrection = true;
    result.trace.steps.push({ step: 'manualOverride', detail: `status ${result.status} overridden to ${status} by approved correction ${override.id}`, values: { correctionId: override.id, computedStatus: result.status, status } });
  }
  return { status, flags: [...flags].sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b)), hasCorrection };
}
const FLAG_ORDER: readonly AttendanceFlag[] = ['LATE', 'EARLY_DEPARTURE', 'OVERTIME', 'MISSING_IN', 'MISSING_OUT', 'MANUAL_CORRECTION', 'OUT_OF_WINDOW', 'WORKED_ON_HOLIDAY', 'WORKED_ON_WEEKLY_OFF', 'HALF_DAY_LEAVE', 'DUPLICATE_PUNCHES_COLLAPSED', 'RAMADAN_HOURS', 'CROSS_MIDNIGHT', 'NO_SHIFT', 'UNDER_HOURS'];

/** RECOMPUTE_DAILY handler: payload `{ organizationId, employeeId, date, reason?, bypassLock?, triggeredBy? }`. */
export async function recomputeDailyHandler({ job, deps, log }: JobContext) {
  const p = parsePayload(recomputePayloadSchema, job.payload);
  const outcome = await withContext(deps.db, { kind: 'system', organizationId: p.organizationId, jobId: job.id }, (trx) =>
    recomputeDaily(trx, { organizationId: p.organizationId, employeeId: p.employeeId, date: p.date, now: deps.now(), reason: p.reason, bypassLock: p.bypassLock, jobId: job.id, triggeredBy: p.triggeredBy ?? null }));
  log.info(event('attendance_recomputed', { employeeId: p.employeeId, date: p.date, reason: p.reason, ...outcome }));
  return outcome;
}

export function registerRecomputeHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'RECOMPUTE_DAILY', handler: recomputeDailyHandler, timeoutMs: 120_000 });
}
