import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';

/** Canonical `punched_at` inside the dedupe hash: UTC ISO-8601 without milliseconds ("2026-09-05T03:00:00Z"). */
export function canonicalPunchedAt(punchedAt: string): string {
  const dt = DateTime.fromISO(punchedAt, { setZone: true });
  return dt.isValid ? (dt.toUTC().toISO({ suppressMilliseconds: true }) ?? punchedAt) : punchedAt;
}

export interface DedupeInput { deviceEmployeeId: string; punchedAt: string; verificationMethod?: string | null; direction?: string | null }

/**
 * The ONE dedupe-hash contract shared by every ingestion path (worker polls/webhooks and API device push), per AGENTS.md:
 * sha256(device_id|device_generation|device_employee_id|punched_at(canonical UTC)|verification|direction).
 * Any change here changes what counts as a duplicate — bump `devices.generation` semantics accordingly.
 */
export function dedupeHash(deviceId: string, generation: number, t: DedupeInput): string {
  return createHash('sha256')
    .update(`${deviceId}|${generation}|${t.deviceEmployeeId}|${canonicalPunchedAt(t.punchedAt)}|${t.verificationMethod ?? 'unknown'}|${t.direction ?? 'unknown'}`)
    .digest('hex');
}
