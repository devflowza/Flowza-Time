import { sql } from 'kysely';
import { z } from 'zod';
import { isoDateSchema, uuidSchema } from '@flowza/contracts';
import { eachDate, errors, event } from '@flowza/shared';
import { withContext, writeAudit, type JobQueue, type Trx } from '@flowza/database';
import type { HandlerRegistry, JobContext } from '../types.js';
import { asDate, chunk, isoDate, parsePayload } from './common.js';
import { recomputeDaily } from './recompute.js';

export const RECALC_CHUNK_SIZE = 200;
const MAX_STORED_ERRORS = 50;

const recalculatePayloadSchema = z.object({ organizationId: uuidSchema, requestId: uuidSchema });

export interface RecalculationScope {
  organizationId: string;
  fromDate: string;
  toDate: string;
  employeeIds?: string[] | null;
  branchId?: string | null;
  departmentId?: string | null;
  reason: string;
  requestedBy?: string | null;
}

export interface RecalculationSummary {
  employees: number;
  dates: number;
  recomputed: number;
  created: number;
  changed: number;
  unchanged: number;
  skippedLocked: number;
  skippedMissing: number;
  errors: Array<{ employeeId: string; date: string; message: string }>;
  errorCount: number;
}

/**
 * Create an `attendance_recalculation_requests` row and queue the RECALCULATE_RANGE job in the same transaction (the API
 * calls this from the caller's context; the worker runs it). Returns the request and queue job ids.
 */
export async function enqueueRecalculationForScope(trx: Trx, queue: JobQueue, scope: RecalculationScope): Promise<{ requestId: string; jobId: string }> {
  if (scope.toDate < scope.fromDate) throw errors.validation('toDate must not precede fromDate.');
  const req = await trx.insertInto('attendanceRecalculationRequests').values({
    organizationId: scope.organizationId, fromDate: scope.fromDate, toDate: scope.toDate,
    branchId: scope.branchId ?? null, departmentId: scope.departmentId ?? null, employeeIds: scope.employeeIds && scope.employeeIds.length ? scope.employeeIds : null,
    reason: scope.reason, requestedBy: scope.requestedBy ?? null, status: 'QUEUED',
  }).returning('id').executeTakeFirstOrThrow();
  const jobId = await queue.enqueue({
    queue: 'processing', jobType: 'RECALCULATE_RANGE', organizationId: scope.organizationId,
    payload: { organizationId: scope.organizationId, requestId: req.id }, priority: 3, dedupeKey: `recalculate:${req.id}`, lockTimeoutSeconds: 3600, maxAttempts: 3,
  }, trx);
  await trx.updateTable('attendanceRecalculationRequests').set({ queueJobId: jobId }).where('id', '=', req.id).execute();
  return { requestId: req.id, jobId };
}

/** Employees in scope: explicit ids, else branch / department (current or via employment history overlapping the range), else everyone employed in the range. */
async function employeesInScope(trx: Trx, organizationId: string, req: { fromDate: string; toDate: string; employeeIds: string[] | null; branchId: string | null; departmentId: string | null }): Promise<string[]> {
  if (req.employeeIds && req.employeeIds.length) {
    const rows = await trx.selectFrom('employees').select('id').where('organizationId', '=', organizationId).where('id', 'in', req.employeeIds).where('deletedAt', 'is', null).execute();
    return rows.map((r) => r.id);
  }
  let q = trx.selectFrom('employees as e').select('e.id').where('e.organizationId', '=', organizationId).where('e.deletedAt', 'is', null)
    .where('e.joiningDate', '<=', asDate(req.toDate))
    .where((eb) => eb.or([eb('e.exitDate', 'is', null), eb('e.exitDate', '>=', asDate(req.fromDate))]));
  const overlap = (col: 'branch_id' | 'department_id', id: string) => sql<boolean>`exists (select 1 from public.employment_history h where h.employee_id = e.id and h.organization_id = e.organization_id and h.${sql.raw(col)} = ${id}::uuid and h.effective_from <= ${req.toDate}::date and (h.effective_to is null or h.effective_to > ${req.fromDate}::date))`;
  if (req.branchId) { const b = req.branchId; q = q.where((eb) => eb.or([eb('e.branchId', '=', b), overlap('branch_id', b)])); }
  if (req.departmentId) { const d = req.departmentId; q = q.where((eb) => eb.or([eb('e.departmentId', '=', d), overlap('department_id', d)])); }
  return (await q.orderBy('e.id').execute()).map((r) => r.id);
}

/**
 * RECALCULATE_RANGE handler (§G.7): employees in scope × dates, recomputed inline in chunks of 200 pairs per transaction
 * with reason RECALCULATION. Locked dates are skipped and counted; per-pair failures are isolated with savepoints and
 * listed in the summary. The request row tracks RUNNING → COMPLETED/FAILED with `summary` and `finished_at`.
 */
export async function recalculateRange({ job, deps, log }: JobContext) {
  const { organizationId, requestId } = parsePayload(recalculatePayloadSchema, job.payload);
  const ctx = { kind: 'system' as const, organizationId, jobId: job.id };
  const req = await withContext(deps.db, ctx, async (trx) => {
    const row = await trx.selectFrom('attendanceRecalculationRequests').selectAll().where('id', '=', requestId).where('organizationId', '=', organizationId).forUpdate().executeTakeFirst();
    if (!row) return null;
    if (row.status === 'COMPLETED' || row.status === 'CANCELLED') return { row, skip: true as const };
    await trx.updateTable('attendanceRecalculationRequests').set({ status: 'RUNNING', startedAt: row.startedAt ?? deps.now(), queueJobId: job.id }).where('id', '=', row.id).execute();
    return { row, skip: false as const };
  });
  if (!req) throw errors.notFound('Recalculation request', requestId);
  if (req.skip) return { skipped: req.row.status };

  const fromDate = isoDate(req.row.fromDate);
  const toDate = isoDate(req.row.toDate);
  const dates = eachDate(fromDate, toDate);
  const employees = await withContext(deps.db, ctx, (trx) => employeesInScope(trx, organizationId, { fromDate, toDate, employeeIds: req.row.employeeIds, branchId: req.row.branchId, departmentId: req.row.departmentId }));
  const summary: RecalculationSummary = { employees: employees.length, dates: dates.length, recomputed: 0, created: 0, changed: 0, unchanged: 0, skippedLocked: 0, skippedMissing: 0, errors: [], errorCount: 0 };
  const pairs: Array<{ employeeId: string; date: string }> = [];
  for (const employeeId of employees) for (const date of dates) pairs.push({ employeeId, date });

  try {
    for (const batch of chunk(pairs, RECALC_CHUNK_SIZE)) {
      await withContext(deps.db, ctx, async (trx) => {
        for (const pair of batch) {
          await sql`savepoint recalc_pair`.execute(trx);
          try {
            const out = await recomputeDaily(trx, { organizationId, employeeId: pair.employeeId, date: pair.date, now: deps.now(), reason: 'RECALCULATION', jobId: job.id, triggeredBy: req.row.requestedBy });
            await sql`release savepoint recalc_pair`.execute(trx);
            switch (out.outcome) {
              case 'created': summary.recomputed++; summary.created++; summary.changed++; break;
              case 'updated': summary.recomputed++; summary.changed++; break;
              case 'unchanged': summary.recomputed++; summary.unchanged++; break;
              case 'skipped_locked': summary.skippedLocked++; break;
              case 'skipped_missing': summary.skippedMissing++; break;
            }
          } catch (err) {
            await sql`rollback to savepoint recalc_pair`.execute(trx);
            summary.errorCount++;
            if (summary.errors.length < MAX_STORED_ERRORS) summary.errors.push({ employeeId: pair.employeeId, date: pair.date, message: String((err as Error).message).slice(0, 300) });
            log.warn(event('recalculation_pair_failed', { requestId, employeeId: pair.employeeId, date: pair.date, err: (err as Error).message }));
          }
        }
        // progress is visible to the UI between chunks
        await trx.updateTable('attendanceRecalculationRequests').set({ summary: JSON.stringify(summary) }).where('id', '=', requestId).execute();
      });
    }
  } catch (err) {
    await withContext(deps.db, ctx, (trx) => trx.updateTable('attendanceRecalculationRequests').set({ status: 'FAILED', finishedAt: deps.now(), summary: JSON.stringify({ ...summary, fatal: String((err as Error).message).slice(0, 500) }) }).where('id', '=', requestId).execute());
    throw err;
  }

  await withContext(deps.db, ctx, async (trx) => {
    await trx.updateTable('attendanceRecalculationRequests').set({ status: 'COMPLETED', finishedAt: deps.now(), summary: JSON.stringify(summary) }).where('id', '=', requestId).execute();
    await writeAudit(trx, {
      organizationId, actorUserId: req.row.requestedBy, actorType: req.row.requestedBy ? 'USER' : 'SYSTEM', action: 'attendance.recalculated', entityType: 'attendance_recalculation_request', entityId: requestId, branchId: req.row.branchId,
      newValue: { fromDate, toDate, branchId: req.row.branchId, departmentId: req.row.departmentId, employeeIds: req.row.employeeIds, recomputed: summary.recomputed, changed: summary.changed, skippedLocked: summary.skippedLocked, errorCount: summary.errorCount },
      reason: req.row.reason, jobId: job.id,
    });
  });
  log.info(event('attendance_recalculated', { requestId, ...summary, errors: undefined }));
  return summary;
}

export function registerRecalculateHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'RECALCULATE_RANGE', handler: recalculateRange, timeoutMs: 3_600_000 });
}

export const recalculationScopeSchema = z.object({
  organizationId: uuidSchema, fromDate: isoDateSchema, toDate: isoDateSchema,
  employeeIds: z.array(uuidSchema).max(1000).nullable().optional(), branchId: uuidSchema.nullable().optional(), departmentId: uuidSchema.nullable().optional(),
  reason: z.string().min(3).max(500), requestedBy: uuidSchema.nullable().optional(),
});
