import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AttendanceEventType, PunchDirection, VerificationMethod } from '@flowza/contracts';
import { uuidSchema } from '@flowza/contracts';
import { addDays, event, isValidTimezone, localDateOf } from '@flowza/shared';
import { withContext, type Trx } from '@flowza/database';
import type { HandlerRegistry, JobContext } from '../types.js';
import { enqueueNormalizeRaw, enqueueRecompute, isoDate, loadProcessingDelaySeconds, parsePayload, uniq } from './common.js';

export const NORMALIZE_BATCH_SIZE = 1000;
export const NORMALIZE_MAX_BATCHES = 20;
const UNMATCHED_ERROR = 'no employee for device user id';

const normalizePayloadSchema = z.object({ organizationId: uuidSchema });

/** Device direction → event type (§G.1). Overtime punches carry no better mapping than PUNCH. */
export function eventTypeForDirection(direction: PunchDirection): AttendanceEventType {
  switch (direction) {
    case 'in': return 'PUNCH_IN';
    case 'out': return 'PUNCH_OUT';
    case 'break_out': return 'BREAK_START';
    case 'break_in': return 'BREAK_END';
    default: return 'PUNCH';
  }
}

interface RawRow { id: string; deviceId: string; providerKey: string; deviceEmployeeId: string; punchedAt: Date; verificationMethod: VerificationMethod; direction: PunchDirection }
interface HistoryRow { employeeId: string; branchId: string; effectiveFrom: string; effectiveTo: string | null }

export interface NormalizeBatchResult { fetched: number; normalized: number; unmatched: number; events: number; recomputeJobs: number }

/** Employment history row effective on `date` (half-open `[from, to)`). */
export function historyOn<T extends { effectiveFrom: string; effectiveTo: string | null }>(rows: readonly T[], date: string): T | undefined {
  return rows.find((h) => h.effectiveFrom <= date && (h.effectiveTo === null || date < h.effectiveTo));
}

/**
 * One batch of the normaliser (§E.4, docs/attendance-engine.md "Worker integration contract"): resolves the employee for
 * each pending raw punch, attaches the branch effective on the local date of the punch, inserts the event and enqueues
 * debounced recomputes. Rows that cannot be resolved become `unmatched` (visible in reconciliation); `held` and
 * `quarantined` rows are never touched here.
 */
export async function normalizeBatch(trx: Trx, organizationId: string, now: Date, queue: JobContext['deps']['queue']): Promise<NormalizeBatchResult> {
  const rows = (await trx.selectFrom('attendanceRawTransactions')
    .select(['id', 'deviceId', 'providerKey', 'deviceEmployeeId', 'punchedAt', 'verificationMethod', 'direction'])
    .where('organizationId', '=', organizationId)
    .where('processingStatus', '=', 'pending')
    .orderBy('punchedAt', 'asc').orderBy('id', 'asc')
    .limit(NORMALIZE_BATCH_SIZE)
    .forUpdate().skipLocked()
    .execute()) as RawRow[];
  if (rows.length === 0) return { fetched: 0, normalized: 0, unmatched: 0, events: 0, recomputeJobs: 0 };

  const deviceIds = uniq(rows.map((r) => r.deviceId));
  const deviceUserIds = uniq(rows.map((r) => r.deviceEmployeeId));
  const providerKeys = uniq(rows.map((r) => r.providerKey));

  // 1. Identity resolution: device state → provider identity → employees.device_user_id.
  const [states, identities, byDeviceUser, devices, branches] = await Promise.all([
    trx.selectFrom('deviceEmployeeStates').select(['deviceId', 'deviceUserId', 'employeeId'])
      .where('organizationId', '=', organizationId).where('deviceId', 'in', deviceIds).where('deviceUserId', 'in', deviceUserIds).where('employeeId', 'is not', null).execute(),
    trx.selectFrom('employeeProviderIdentities').select(['providerKey', 'deviceUserId', 'employeeId'])
      .where('organizationId', '=', organizationId).where('providerKey', 'in', providerKeys).where('deviceUserId', 'in', deviceUserIds).execute(),
    trx.selectFrom('employees').select(['id', 'deviceUserId'])
      .where('organizationId', '=', organizationId).where('deviceUserId', 'in', deviceUserIds).where('deletedAt', 'is', null).execute(),
    trx.selectFrom('devices').select(['id', 'timezone', 'branchId']).where('organizationId', '=', organizationId).where('id', 'in', deviceIds).execute(),
    trx.selectFrom('branches').select(['id', 'timezone']).where('organizationId', '=', organizationId).execute(),
  ]);
  const stateMap = new Map(states.map((s) => [`${s.deviceId}|${s.deviceUserId}`, s.employeeId as string]));
  const identityMap = new Map(identities.map((i) => [`${i.providerKey}|${i.deviceUserId}`, i.employeeId]));
  const deviceUserMap = new Map(byDeviceUser.map((e) => [e.deviceUserId, e.id]));
  const deviceMap = new Map(devices.map((d) => [d.id, d]));
  const branchTz = new Map(branches.map((b) => [b.id, b.timezone]));

  const resolveEmployee = (r: RawRow): string | null =>
    stateMap.get(`${r.deviceId}|${r.deviceEmployeeId}`) ?? identityMap.get(`${r.providerKey}|${r.deviceEmployeeId}`) ?? deviceUserMap.get(r.deviceEmployeeId) ?? null;

  const candidateIds = uniq(rows.map(resolveEmployee).filter((id): id is string => id !== null));
  const employees = candidateIds.length
    ? await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', organizationId).where('id', 'in', candidateIds).where('deletedAt', 'is', null).execute()
    : [];
  const employeeMap = new Map(employees.map((e) => [e.id, e]));
  const historyRows = candidateIds.length
    ? await trx.selectFrom('employmentHistory').select(['employeeId', 'branchId', 'effectiveFrom', 'effectiveTo'])
      .where('organizationId', '=', organizationId).where('employeeId', 'in', candidateIds).orderBy('effectiveFrom', 'desc').execute()
    : [];
  const history = new Map<string, HistoryRow[]>();
  for (const h of historyRows) {
    const list = history.get(h.employeeId) ?? [];
    list.push({ employeeId: h.employeeId, branchId: h.branchId, effectiveFrom: isoDate(h.effectiveFrom), effectiveTo: h.effectiveTo === null ? null : isoDate(h.effectiveTo) });
    history.set(h.employeeId, list);
  }

  // 2. Build events + touched (employee, local date) pairs.
  const eventRows: Array<{ organizationId: string; employeeId: string; branchId: string; deviceId: string; rawTransactionId: string; source: 'DEVICE'; eventType: AttendanceEventType; punchedAt: Date; verificationMethod: VerificationMethod }> = [];
  const normalized: Array<{ id: string; employeeId: string }> = [];
  const unmatched: string[] = [];
  const touched = new Map<string, { employeeId: string; date: string }>();
  const touch = (employeeId: string, date: string): void => { touched.set(`${employeeId}|${date}`, { employeeId, date }); };

  for (const r of rows) {
    const employeeId = resolveEmployee(r);
    const employee = employeeId ? employeeMap.get(employeeId) : undefined;
    if (!employeeId || !employee) { unmatched.push(r.id); continue; }
    const device = deviceMap.get(r.deviceId);
    const fallbackTz = branchTz.get(employee.branchId) ?? 'UTC';
    const deviceTz = device && isValidTimezone(device.timezone) ? device.timezone : fallbackTz;
    const punchedAt = r.punchedAt instanceof Date ? r.punchedAt : new Date(r.punchedAt);
    const hist = history.get(employeeId) ?? [];
    // effective branch on the local date of the punch; the local date itself depends on the branch timezone, so iterate once
    let localDate = localDateOf(punchedAt, deviceTz);
    let branchId = historyOn(hist, localDate)?.branchId ?? employee.branchId;
    let tz = branchTz.get(branchId) ?? deviceTz;
    const secondPass = localDateOf(punchedAt, tz);
    if (secondPass !== localDate) {
      localDate = secondPass;
      branchId = historyOn(hist, localDate)?.branchId ?? employee.branchId;
      tz = branchTz.get(branchId) ?? deviceTz;
      localDate = localDateOf(punchedAt, tz);
    }
    eventRows.push({ organizationId, employeeId, branchId, deviceId: r.deviceId, rawTransactionId: r.id, source: 'DEVICE', eventType: eventTypeForDirection(r.direction), punchedAt, verificationMethod: r.verificationMethod });
    normalized.push({ id: r.id, employeeId });
    touch(employeeId, localDate);
    // before noon local the punch may close a shift that started the previous day (§G.3 cross-midnight)
    if (DateTime.fromJSDate(punchedAt).setZone(tz).hour < 12) touch(employeeId, addDays(localDate, -1));
  }

  // 3. Persist: events (idempotent on raw id), raw bookkeeping, recompute jobs — all in this transaction.
  let inserted = 0;
  for (let i = 0; i < eventRows.length; i += 500) {
    const res = await trx.insertInto('attendanceEvents').values(eventRows.slice(i, i + 500))
      .onConflict((oc) => oc.columns(['rawTransactionId', 'punchedAt']).where('rawTransactionId', 'is not', null).doNothing())
      .executeTakeFirst();
    inserted += Number(res.numInsertedOrUpdatedRows ?? 0);
  }
  if (normalized.length) {
    await sql`update public.attendance_raw_transactions r
      set employee_id = v.employee_id, processing_status = 'normalized', processing_error = null, processed_at = now()
      from unnest(${sql.val(normalized.map((n) => n.id))}::bigint[], ${sql.val(normalized.map((n) => n.employeeId))}::uuid[]) as v(id, employee_id)
      where r.id = v.id and r.organization_id = ${organizationId}::uuid and r.processing_status = 'pending'`.execute(trx);
  }
  if (unmatched.length) {
    await sql`update public.attendance_raw_transactions
      set processing_status = 'unmatched', processing_error = ${UNMATCHED_ERROR}, processed_at = now()
      where id = any(${sql.val(unmatched)}::bigint[]) and organization_id = ${organizationId}::uuid and processing_status = 'pending'`.execute(trx);
  }
  let recomputeJobs = 0;
  if (touched.size) {
    const delay = await loadProcessingDelaySeconds(trx, organizationId);
    const runAt = new Date(now.getTime() + delay * 1000);
    for (const t of touched.values()) {
      await enqueueRecompute(queue, { organizationId, employeeId: t.employeeId, date: t.date, reason: 'NEW_EVENT', runAt }, trx);
      recomputeJobs++;
    }
  }
  return { fetched: rows.length, normalized: normalized.length, unmatched: unmatched.length, events: inserted, recomputeJobs };
}

/** NORMALIZE_RAW handler: batches of 1000 oldest-first until the backlog is below a batch or 20 batches ran (then continues in a new job). */
export async function normalizeRaw({ job, deps, log }: JobContext) {
  const { organizationId } = parsePayload(normalizePayloadSchema, job.payload);
  const totals = { batches: 0, fetched: 0, normalized: 0, unmatched: 0, events: 0, recomputeJobs: 0, requeued: false };
  while (totals.batches < NORMALIZE_MAX_BATCHES) {
    const res = await withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, (trx) => normalizeBatch(trx, organizationId, deps.now(), deps.queue));
    totals.batches++;
    totals.fetched += res.fetched; totals.normalized += res.normalized; totals.unmatched += res.unmatched; totals.events += res.events; totals.recomputeJobs += res.recomputeJobs;
    if (res.fetched < NORMALIZE_BATCH_SIZE) break;
  }
  if (totals.batches >= NORMALIZE_MAX_BATCHES) {
    await enqueueNormalizeRaw(deps.queue, organizationId, { continuation: true });
    totals.requeued = true;
  }
  if (totals.fetched > 0) log.info(event('raw_transactions_normalized', { organizationId, ...totals }));
  return totals;
}

export function registerNormalizeHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'NORMALIZE_RAW', handler: normalizeRaw, timeoutMs: 600_000 });
}
