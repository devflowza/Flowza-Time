import { DateTime } from 'luxon';
import type { RawSource, RawTransaction } from '@flowza/contracts';
import { sha256Hex } from '@flowza/shared';
import { emitDomainEvent, type JobQueue, type RawProcessingStatus, type Trx } from '@flowza/database';
import { sql } from 'kysely';
import type { DeviceRow, OrgSyncSettings } from './types.js';
import { loadOrgSyncSettings } from './context.js';

export const FUTURE_TOLERANCE_MS = 10 * 60_000;
export const RAW_PAYLOAD_MAX_BYTES = 16 * 1024;
const INSERT_CHUNK = 500;

export type IngestDevice = Pick<DeviceRow, 'id' | 'organizationId' | 'branchId' | 'name' | 'providerKey' | 'generation' | 'timezone' | 'lastClockSkewSeconds'>;

export interface IngestInput {
  organizationId: string;
  device: IngestDevice;
  source: RawSource;
  syncJobId: string | null;
  transactions: RawTransaction[];
  /** Ingestion instant (defaults to now). Also used as `received_at` for skew checks. */
  now?: Date;
  settings?: OrgSyncSettings;
  queue?: JobQueue;
  /** Skip the device bookkeeping (heartbeat, connection status, device_logs). */
  skipDeviceUpdate?: boolean;
}

export interface IngestResult { inserted: number; duplicates: number; quarantined: number; held: number; ids: string[] }

// Dedupe hash + canonical punched_at live in @flowza/database (shared with the API device-push ingest).
import { canonicalPunchedAt, dedupeHash } from '@flowza/database';
export { canonicalPunchedAt, dedupeHash };

/** Raw payloads are capped at 16 KB; oversize payloads are replaced by their hash (never silently truncated JSON). */
export function boundRawPayload(payload: unknown): string {
  const json = JSON.stringify(payload && typeof payload === 'object' ? payload : {});
  if (Buffer.byteLength(json, 'utf8') <= RAW_PAYLOAD_MAX_BYTES) return json;
  return JSON.stringify({ truncated: true, bytes: Buffer.byteLength(json, 'utf8'), sha256: sha256Hex(json) });
}

export interface LockRow { branchId: string | null; periodStart: Date | string; periodEnd: Date | string }

async function loadActiveLocks(trx: Trx, organizationId: string, branchId: string | null): Promise<LockRow[]> {
  let q = trx.selectFrom('attendancePeriodLocks').select(['branchId', 'periodStart', 'periodEnd']).where('organizationId', '=', organizationId).where('unlockedAt', 'is', null);
  q = branchId ? q.where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', '=', branchId)])) : q.where('branchId', 'is', null);
  return q.execute();
}

/**
 * `period_start` / `period_end` are SQL `date` columns; node-pg materialises them as a JS Date at *local* midnight of the
 * worker process. Reading the calendar date back therefore has to use the same (process-local) zone — formatting in UTC
 * shifts every lock by a day on hosts east of Greenwich.
 */
export const lockDate = (d: Date | string): string => (typeof d === 'string' ? d.slice(0, 10) : DateTime.fromJSDate(d).toISODate() ?? '');

export function isLocked(locks: LockRow[], localDate: string): boolean {
  return locks.some((l) => localDate >= lockDate(l.periodStart) && localDate <= lockDate(l.periodEnd));
}

/**
 * Idempotent raw ingestion (§E.4, §F.4). One INSERT … ON CONFLICT DO NOTHING covers both unique indexes (provider transaction
 * id and dedupe hash); duplicates = offered − inserted. Implausible timestamps (future beyond 10 min, device clock skew beyond
 * the org threshold) land as `quarantined`, punches inside a locked period as `held`; everything else is `pending` for the
 * normaliser, which is woken by ONE `NORMALIZE_RAW` job per organisation (dedupe key `normalize:<org>`).
 */
export async function ingestRawTransactions(trx: Trx, input: IngestInput): Promise<IngestResult> {
  const now = input.now ?? new Date();
  const { device, organizationId } = input;
  const result: IngestResult = { inserted: 0, duplicates: 0, quarantined: 0, held: 0, ids: [] };
  const offered = input.transactions.length;
  if (offered > 0) {
    const settings = input.settings ?? (await loadOrgSyncSettings(trx, organizationId));
    const locks = await loadActiveLocks(trx, organizationId, device.branchId);
    const skewSeconds = device.lastClockSkewSeconds ?? 0;
    const skewExceeded = Math.abs(skewSeconds) > settings.maxClockSkewMinutes * 60;
    const seen = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    for (const t of input.transactions) {
      const punched = new Date(t.punchedAt);
      if (Number.isNaN(punched.getTime())) continue; // unparseable timestamp: the provider contract (rawTransactionSchema) forbids it; never insert garbage
      const hash = dedupeHash(device.id, device.generation, t);
      if (seen.has(hash)) { result.duplicates++; continue; }
      seen.add(hash);
      let status: RawProcessingStatus = 'pending';
      let error: string | null = null;
      if (punched.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) { status = 'quarantined'; error = 'punched_at is in the future'; }
      else if (skewExceeded) { status = 'quarantined'; error = `device clock skew ${skewSeconds}s exceeds ${settings.maxClockSkewMinutes} min`; }
      else if (locks.length > 0 && isLocked(locks, DateTime.fromJSDate(punched).setZone(device.timezone).toISODate() ?? '')) { status = 'held'; error = 'punched inside a locked attendance period'; }
      rows.push({
        organizationId, deviceId: device.id, branchId: device.branchId, providerKey: device.providerKey, providerTransactionId: t.providerTransactionId ?? null,
        deviceEmployeeId: t.deviceEmployeeId, punchedAt: punched, deviceLocalTime: t.deviceLocalTime ?? null, assumedTimezone: device.timezone, clockSkewSeconds: device.lastClockSkewSeconds ?? null,
        verificationMethod: t.verificationMethod ?? 'unknown', direction: t.direction ?? 'unknown', rawPayload: boundRawPayload(t.rawPayload), receivedAt: now, source: input.source,
        syncJobId: input.syncJobId, dedupeHash: hash, deviceGeneration: device.generation, processingStatus: status, processingError: error,
      });
    }
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const inserted = await trx.insertInto('attendanceRawTransactions').values(chunk as never).onConflict((oc) => oc.doNothing()).returning(['id', 'processingStatus']).execute();
      for (const r of inserted) {
        result.ids.push(String(r.id));
        if (r.processingStatus === 'quarantined') result.quarantined++;
        else if (r.processingStatus === 'held') result.held++;
      }
      result.inserted += inserted.length;
      result.duplicates += chunk.length - inserted.length;
    }
    if (result.inserted > 0 && input.queue) {
      await input.queue.enqueue({ queue: 'processing', jobType: 'NORMALIZE_RAW', organizationId, payload: { organizationId }, priority: 6, dedupeKey: `normalize:${organizationId}`, lockTimeoutSeconds: 600, maxAttempts: 3 }, trx);
    }
  }
  if (!input.skipDeviceUpdate) {
    // one statement: bookkeeping + the previous connection status, so a device that was declared offline and answers again
    // emits `device.online` exactly like a health check would (the "back online" notification must not depend on the path)
    const prev = await sql<{ previous: string }>`
      update public.devices d set last_attendance_sync_at = ${now}, last_successful_communication_at = ${now}, connection_status = 'online', consecutive_failures = 0, last_error_code = null, last_error = null
      from (select id, connection_status from public.devices where id = ${device.id}::uuid for update) o
      where d.id = o.id
      returning o.connection_status::text as previous`.execute(trx);
    await trx.insertInto('deviceLogs').values({
      organizationId, deviceId: device.id, level: result.quarantined > 0 ? 'warn' : 'info', event: 'attendance_pulled', jobId: input.syncJobId,
      message: `${result.inserted} new punches (${result.duplicates} duplicates, ${result.quarantined} quarantined, ${result.held} held)`,
      details: JSON.stringify({ source: input.source, offered, inserted: result.inserted, duplicates: result.duplicates, quarantined: result.quarantined, held: result.held }),
    }).execute();
    if (prev.rows[0]?.previous === 'offline') {
      await emitDomainEvent(trx, {
        organizationId, eventType: 'device.online', aggregateType: 'device', aggregateId: device.id,
        payload: { deviceId: device.id, deviceName: device.name, branchId: device.branchId, lastSeenAt: now.toISOString(), via: input.source },
      });
    }
  }
  return result;
}
