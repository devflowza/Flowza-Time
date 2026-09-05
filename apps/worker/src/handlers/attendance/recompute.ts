import { sql, type Selectable } from 'kysely';
import { ATTENDANCE_FLAGS, type AttendanceFlag, type AttendanceStatus } from '@flowza/contracts';
import { event } from '@flowza/shared';
import { bypassPeriodLock, emitDomainEvent, withContext, type DB, type RecordHistoryReason, type Trx } from '@flowza/database';
import { calculateDailyRecord, type DailyCalculationResult } from '@flowza/domain';
import type { HandlerRegistry, JobContext } from '../types.js';
import { asDate, parsePayload, recomputePayloadSchema } from './common.js';
import { loadDailyInputs, type LoadedDailyInputs } from './load-inputs.js';

type DailyRecordRow = Selectable<DB['attendanceDailyRecords']>;

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

  // Row lock: an immediate (correction) and a debounced recompute of the same day may run concurrently; serialise them so the
  // version chain and history snapshots stay linear.
  const existing = await trx.selectFrom('attendanceDailyRecords').selectAll()
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).where('attendanceDate', '=', asDate(date)).forUpdate().executeTakeFirst();

  // Lock check on the new branch and, when the record moves branches, on the old one too.
  const branchesToCheck = [...new Set([loaded.branchId, ...(existing ? [existing.branchId] : [])])];
  let locked = false;
  for (const b of branchesToCheck) if (await isPeriodLocked(trx, organizationId, b, date)) { locked = true; break; }
  if (locked) {
    if (!opts.bypassLock) return { outcome: 'skipped_locked', branchId: loaded.branchId, ...(existing ? { recordId: existing.id, version: existing.calculationVersion, status: existing.status } : {}) };
    await bypassPeriodLock(trx);
  }
  const outcome = await writeRecord(trx, opts, loaded, existing);
  // The bypass is transaction-local, but a transaction may hold many records (recalculation chunks): switch it off again right
  // after this record so nothing else in the same transaction can slip past the period-lock trigger.
  if (locked) await sql`select set_config('flowza.bypass_period_lock', 'off', true)`.execute(trx);
  return outcome;
}

async function writeRecord(trx: Trx, opts: RecomputeOptions, loaded: LoadedDailyInputs, existing: DailyRecordRow | undefined): Promise<RecomputeOutcome> {
  const { organizationId, employeeId, date } = opts;
  const result = calculateDailyRecord(loaded.input);
  const { status, flags, hasCorrection } = await applyCorrections(trx, organizationId, employeeId, date, result, loaded.eventSources);

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
 * Applied corrections for the date are folded into the record on every recompute, so it stays reproducible from
 * raw + corrections: any applied correction (also a REMOVE_PUNCH, whose voided event the engine never sees) marks the record
 * `has_correction` + MANUAL_CORRECTION, and the latest applied SET_STATUS overrides the computed status (the engine result
 * stays in the trace).
 */
async function applyCorrections(trx: Trx, organizationId: string, employeeId: string, date: string, result: DailyCalculationResult, eventSources: Map<string, 'DEVICE' | 'MANUAL' | 'CORRECTION' | 'IMPORT' | 'MOBILE'>): Promise<{ status: AttendanceStatus; flags: AttendanceFlag[]; hasCorrection: boolean }> {
  let hasCorrection = result.eventIds.some((id) => { const s = eventSources.get(id); return s === 'CORRECTION' || s === 'MANUAL'; });
  let status = result.status;
  const flags = new Set<AttendanceFlag>(result.flags);
  const applied = await trx.selectFrom('attendanceCorrections').select(['id', 'type', 'proposedStatus', 'appliedAt'])
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).where('attendanceDate', '=', asDate(date))
    .where('status', '=', 'APPLIED')
    .orderBy('appliedAt', 'asc').orderBy('id', 'asc').execute();
  if (applied.length > 0) {
    hasCorrection = true;
    flags.add('MANUAL_CORRECTION');
    result.trace.steps.push({ step: 'corrections', detail: `${applied.length} applied correction(s) on this date → has_correction`, values: { corrections: applied.map((c) => ({ id: c.id, type: c.type })) } });
  }
  const override = [...applied].reverse().find((c) => c.type === 'SET_STATUS' && c.proposedStatus !== null);
  if (override?.proposedStatus) {
    status = override.proposedStatus;
    result.trace.steps.push({ step: 'manualOverride', detail: `status ${result.status} overridden to ${status} by approved correction ${override.id}`, values: { correctionId: override.id, computedStatus: result.status, status } });
  }
  // canonical flag order (the engine uses the same one) so equal results always serialise identically
  return { status, flags: ATTENDANCE_FLAGS.filter((f) => flags.has(f)), hasCorrection };
}

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
