import { DateTime } from 'luxon';
import type { RawTransaction, RawSource } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { sha256Hex } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { enqueueJob } from '../../lib/jobs.js';

/** Punches this far in the future (server clock) are quarantined (device clock badly wrong). */
export const FUTURE_SKEW_QUARANTINE_SECONDS = 300;
/** Raw payload budget (AGENTS.md service-level rules: 16 KB cap; binary/template fields stripped by the provider). */
export const RAW_PAYLOAD_MAX_BYTES = 16 * 1024;
/** Clock skew is stored in an int4 column; ±20 years is more than any real device drift. */
export const MAX_SKEW_SECONDS = 20 * 365 * 86_400;

export interface IngestDevice { id: string; organizationId: string; generation: number; providerKey: string; branchId: string | null; timezone: string }
export interface IngestOptions { source: RawSource; syncJobId?: string | null; now?: Date; locks?: { branchId: string | null; periodStart: string; periodEnd: string }[] }
export interface IngestResult { received: number; inserted: number; duplicates: number; quarantined: number; held: number; ids: string[] }

/** Dedupe hash exactly as the worker computes it: sha256(device_id|device_generation|device_employee_id|punched_at|verification|direction). */
export function dedupeHash(deviceId: string, generation: number, tx: RawTransaction): string {
  const at = DateTime.fromISO(tx.punchedAt, { setZone: true }).toUTC().toISO({ suppressMilliseconds: true }) ?? tx.punchedAt;
  return sha256Hex(`${deviceId}|${generation}|${tx.deviceEmployeeId}|${at}|${tx.verificationMethod}|${tx.direction}`);
}

function boundedPayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(json, 'utf8') <= RAW_PAYLOAD_MAX_BYTES) return json;
  return JSON.stringify({ truncated: true, bytes: Buffer.byteLength(json, 'utf8'), sha256: sha256Hex(json) });
}

/**
 * Idempotent raw insert shared by the device-push route (and, later, the worker): unique on the dedupe hash and on the
 * provider transaction id, so replays insert nothing. Future punches → `quarantined`; punches inside a locked period →
 * `held` (HR decides). Must run in system-for-org context.
 */
export async function ingestRawTransactions(trx: Trx, device: IngestDevice, transactions: RawTransaction[], opts: IngestOptions): Promise<IngestResult> {
  const result: IngestResult = { received: transactions.length, inserted: 0, duplicates: 0, quarantined: 0, held: 0, ids: [] };
  if (transactions.length === 0) return result;
  const now = opts.now ?? new Date();
  const locks = opts.locks ?? (await trx.selectFrom('attendancePeriodLocks').select(['branchId', 'periodStart', 'periodEnd']).where('organizationId', '=', device.organizationId).where('unlockedAt', 'is', null).execute()).map((l) => ({ branchId: l.branchId, periodStart: iso(l.periodStart), periodEnd: iso(l.periodEnd) }));
  const rows = transactions.map((tx) => {
    const punchedAt = new Date(tx.punchedAt);
    // int4 column: clamp absurd device clocks (a year 2099 punch) instead of failing the whole upload
    const skew = Math.max(-MAX_SKEW_SECONDS, Math.min(MAX_SKEW_SECONDS, Math.round((punchedAt.getTime() - now.getTime()) / 1000)));
    const localDate = DateTime.fromJSDate(punchedAt).setZone(device.timezone).toISODate() ?? tx.punchedAt.slice(0, 10);
    let status: 'pending' | 'quarantined' | 'held' = 'pending';
    if (skew > FUTURE_SKEW_QUARANTINE_SECONDS) status = 'quarantined';
    else if (locks.some((l) => (l.branchId === null || l.branchId === device.branchId) && l.periodStart <= localDate && localDate <= l.periodEnd)) status = 'held';
    return {
      organizationId: device.organizationId, deviceId: device.id, branchId: device.branchId, providerKey: device.providerKey, providerTransactionId: tx.providerTransactionId, deviceEmployeeId: tx.deviceEmployeeId, punchedAt,
      deviceLocalTime: tx.deviceLocalTime ?? null, assumedTimezone: device.timezone, clockSkewSeconds: skew, verificationMethod: tx.verificationMethod, direction: tx.direction, rawPayload: boundedPayload(tx.rawPayload), dedupeHash: dedupeHash(device.id, device.generation, tx),
      deviceGeneration: device.generation, source: opts.source, syncJobId: opts.syncJobId ?? null, processingStatus: status, processingError: status === 'quarantined' ? `clock skew ${skew}s (future punch)` : status === 'held' ? 'period locked at ingestion' : null,
    };
  });
  // de-duplicate inside the batch first (same punch twice in one upload) so the multi-row insert cannot conflict with itself
  const seen = new Set<string>();
  const unique = rows.filter((r) => { const k = `${r.dedupeHash}|${r.punchedAt.toISOString()}`; if (seen.has(k)) { result.duplicates += 1; return false; } seen.add(k); return true; });
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const inserted = await trx.insertInto('attendanceRawTransactions').values(chunk).onConflict((oc) => oc.doNothing()).returning(['id', 'processingStatus']).execute();
    result.inserted += inserted.length;
    result.duplicates += chunk.length - inserted.length;
    for (const r of inserted) { result.ids.push(String(r.id)); if (r.processingStatus === 'quarantined') result.quarantined += 1; else if (r.processingStatus === 'held') result.held += 1; }
  }
  return result;
}

/** Debounced normaliser wake-up (one pending job per organisation). */
export async function enqueueNormalize(deps: ApiDeps, trx: Trx, organizationId: string, deviceId: string, correlationId: string): Promise<string> {
  return enqueueJob(deps.queue, trx, { queue: 'processing', jobType: 'NORMALIZE_RAW', organizationId, payload: { organizationId, deviceId }, dedupeKey: `normalize:${organizationId}`, correlationId, priority: 6 });
}

function iso(d: Date | string): string { return typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
