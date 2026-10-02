import { sql } from 'kysely';
import { z } from 'zod';
import { isoDateSchema, uuidSchema, type EmploymentStatus } from '@flowza/contracts';
import { addDays, eachDate, event } from '@flowza/shared';
import { withContext, type Trx } from '@flowza/database';
import { isLockLost, type HandlerRegistry, type JobContext } from '../types.js';
import { asDate, chunk, isoDate, parsePayload } from './common.js';
import { orgLocalDate } from './day-close.js';
import { recomputeDaily } from './recompute.js';

/**
 * Daily-record materialisation (2026-10-02 field report, bug 3: "the daily view marks a day without a shift Absent while the
 * monthly summary drops it"). A record exists for an (employee, date) only once something recomputed it — a punch, a
 * correction, a change of shift / rule set / holiday / leave, an explicit recalculation — so a working day nobody punched on, a
 * weekly off or a holiday of an employee whose schedule never changed was never calculated, and sat in no column of the
 * monthly summary or the monthly reports while the register showed other such days. This sweep closes the gap: every hour,
 * per organisation, it calculates each day of the last MATERIALIZE_LOOKBACK_DAYS (up to yesterday, organisation time) that an
 * employee employed on it has no record for, and re-judges the records of those days still PENDING (a missing check-out is
 * judged once its window has closed instead of waiting for the next punch).
 *
 * The one rule for a working day without a resolved shift (and without the organisation's default shift) is the engine's: it is
 * judged like any other working day — with punches it is PRESENT (hours from the punches, flag NO_SHIFT), without punches it is
 * ABSENT (flag NO_SHIFT) once the day is over; weekly offs and holidays do not depend on the shift. The register, the monthly
 * summary and the reports all read the records this sweep writes, so they agree; days of a longer gap (a month that was never
 * calculated) show as "not calculated" on the summary until a recalculation fills them.
 *
 * Employees: not deleted, employed on the date (joining / exit dates), and active or on leave — a suspended employee, or one who
 * left without an exit date, is not given a stream of absences automatically. Locked periods are skipped (as every recompute
 * does); per-day failures are isolated with savepoints; at most MATERIALIZE_MAX_PAIRS days per run (the next run continues).
 */
export const MATERIALIZE_JOB_TYPE = 'ATTENDANCE_MATERIALIZE_DAYS';
export const MATERIALIZE_LOOKBACK_DAYS = 3;
export const MATERIALIZE_MAX_PAIRS = 20_000;
const CHUNK_SIZE = 200;
const MATERIALIZED_STATUSES: readonly EmploymentStatus[] = ['active', 'on_leave'];

export const materializePayloadSchema = z.object({
  organizationId: uuidSchema,
  /** "Today" in the organisation's timezone; defaults to the current local date. Days before it are materialised. */
  asOf: isoDateSchema.optional(),
  lookbackDays: z.number().int().min(1).max(31).optional(),
});
export type MaterializePayload = z.infer<typeof materializePayloadSchema>;

export const materializeDedupeKey = (organizationId: string): string => `materialize:${organizationId}`;

export interface MaterializeSummary { asOf: string; fromDate: string; toDate: string; employees: number; pairs: number; created: number; updated: number; unchanged: number; skippedLocked: number; skippedMissing: number; errors: number; capped: boolean; abandoned?: boolean }

/** The (employee, date) pairs of the window without a record, or whose record is still PENDING — oldest first. */
export async function pairsToMaterialize(trx: Trx, organizationId: string, fromDate: string, toDate: string): Promise<{ employees: number; pairs: Array<{ employeeId: string; date: string }>; capped: boolean }> {
  const employees = await trx.selectFrom('employees').select(['id', 'joiningDate', 'exitDate'])
    .where('organizationId', '=', organizationId).where('deletedAt', 'is', null)
    .where('joiningDate', '<=', asDate(toDate)).where((eb) => eb.or([eb('exitDate', 'is', null), eb('exitDate', '>=', asDate(fromDate))]))
    // an employee who left has days up to the exit date; one suspended (or marked as left without an exit date) gets none here
    .where((eb) => eb.or([eb('employmentStatus', 'in', [...MATERIALIZED_STATUSES]), eb('exitDate', 'is not', null)]))
    .orderBy('id').execute();
  if (employees.length === 0) return { employees: 0, pairs: [], capped: false };
  const known = new Set<string>();
  for (const batch of chunk(employees.map((e) => e.id), 1000)) {
    const rows = await trx.selectFrom('attendanceDailyRecords').select(['employeeId', 'attendanceDate'])
      .where('organizationId', '=', organizationId).where('employeeId', 'in', batch)
      .where('attendanceDate', '>=', asDate(fromDate)).where('attendanceDate', '<=', asDate(toDate))
      .where('status', '<>', 'PENDING').execute();
    for (const r of rows) known.add(`${r.employeeId}|${isoDate(r.attendanceDate)}`);
  }
  const pairs: Array<{ employeeId: string; date: string }> = [];
  for (const date of eachDate(fromDate, toDate)) {
    for (const e of employees) {
      if (isoDate(e.joiningDate) > date || (e.exitDate !== null && isoDate(e.exitDate) < date)) continue;
      if (!known.has(`${e.id}|${date}`)) pairs.push({ employeeId: e.id, date });
    }
  }
  return { employees: employees.length, pairs: pairs.slice(0, MATERIALIZE_MAX_PAIRS), capped: pairs.length > MATERIALIZE_MAX_PAIRS };
}

/**
 * ATTENDANCE_MATERIALIZE_DAYS handler: payload `{ organizationId, asOf?, lookbackDays? }`, one organisation per job, in its
 * system context, in chunks of CHUNK_SIZE days per transaction (reason RECALCULATION, as a recalculation request writes them).
 */
export async function materializeHandler({ job, deps, log, signal }: JobContext): Promise<MaterializeSummary> {
  const p = parsePayload(materializePayloadSchema, job.payload);
  const ctx = { kind: 'system' as const, organizationId: p.organizationId, jobId: job.id };
  const now = deps.now();
  const { asOf, fromDate, toDate, found } = await withContext(deps.db, ctx, async (trx) => {
    const today = p.asOf ?? await orgLocalDate(trx, p.organizationId, now);
    const to = addDays(today, -1);
    const from = addDays(today, -(p.lookbackDays ?? MATERIALIZE_LOOKBACK_DAYS));
    return { asOf: today, fromDate: from, toDate: to, found: await pairsToMaterialize(trx, p.organizationId, from, to) };
  });
  const summary: MaterializeSummary = { asOf, fromDate, toDate, employees: found.employees, pairs: found.pairs.length, created: 0, updated: 0, unchanged: 0, skippedLocked: 0, skippedMissing: 0, errors: 0, capped: found.capped };
  for (const batch of chunk(found.pairs, CHUNK_SIZE)) {
    if (isLockLost(signal)) { summary.abandoned = true; break; }
    await withContext(deps.db, ctx, async (trx) => {
      for (const pair of batch) {
        await sql`savepoint materialize_pair`.execute(trx);
        try {
          const out = await recomputeDaily(trx, { organizationId: p.organizationId, employeeId: pair.employeeId, date: pair.date, now: deps.now(), reason: 'RECALCULATION', jobId: job.id, triggeredBy: null });
          await sql`release savepoint materialize_pair`.execute(trx);
          switch (out.outcome) {
            case 'created': summary.created++; break;
            case 'updated': summary.updated++; break;
            case 'unchanged': summary.unchanged++; break;
            case 'skipped_locked': summary.skippedLocked++; break;
            case 'skipped_missing': summary.skippedMissing++; break;
          }
        } catch (err) {
          await sql`rollback to savepoint materialize_pair`.execute(trx);
          summary.errors++;
          log.warn(event('attendance_materialize_pair_failed', { organizationId: p.organizationId, jobId: job.id, employeeId: pair.employeeId, date: pair.date, err: (err as Error).message }));
        }
      }
    });
  }
  log.info(event('attendance_materialized', { organizationId: p.organizationId, jobId: job.id, ...summary }));
  return summary;
}

export function registerMaterializeHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: MATERIALIZE_JOB_TYPE, handler: materializeHandler, timeoutMs: 1_800_000 });
}
