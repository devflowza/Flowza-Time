import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import { resolveAttendanceSettings, type AttendanceSettings } from '@flowza/contracts';
import { errors } from '@flowza/shared';
import type { JobQueue, Trx } from '@flowza/database';

// The RECOMPUTE_DAILY contract (reasons, payload schema, dedupe key, enqueue) lives in @flowza/database so the API's day-mark
// and pay-effect writers enqueue exactly the job this worker consumes; re-exported here for the handlers and their tests.
export { RECOMPUTE_REASONS, recomputeReasonSchema, recomputePayloadSchema, IMMEDIATE_RECOMPUTE_REASONS, recomputeDedupeKey, enqueueRecompute, type RecomputeReason, type RecomputePayload, type EnqueueRecomputeInput } from '@flowza/database';

export const DEFAULT_PROCESSING_DELAY_SECONDS = 30;

/** The organisation's effective attendance settings (`organization_settings.attendance`, defaults filled in; never throws). */
export async function loadAttendanceSettings(trx: Trx, organizationId: string): Promise<AttendanceSettings> {
  const row = await trx.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', organizationId).executeTakeFirst();
  return resolveAttendanceSettings(asObject(row?.attendance));
}

/** Parse a job payload with a stable, non-retryable error (a malformed payload never gets better by retrying). */
export function parsePayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const res = schema.safeParse(payload);
  if (!res.success) throw errors.validation('Invalid job payload.', { issues: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  return res.data;
}

/** `date` columns arrive as JS Dates built from local components (pg-types) or as `YYYY-MM-DD` strings. */
export function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return DateTime.fromJSDate(v).toISODate() ?? v.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → a `date` expression usable against Kysely's Date-typed date columns. */
export const asDate = (date: string) => sql<Date>`${date}::date`;

export function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/** Coerce a jsonb column to a plain object (jsonb arrives parsed; tolerate legacy string storage). */
export function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') { try { return asObject(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asArray(v: unknown): unknown[] {
  if (typeof v === 'string') { try { return asArray(JSON.parse(v)); } catch { return []; } }
  return Array.isArray(v) ? v : [];
}

/** `organization_settings.attendance.processingDelaySeconds` (debounce between the last punch and the recompute). */
export async function loadProcessingDelaySeconds(trx: Trx, organizationId: string): Promise<number> {
  const row = await trx.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', organizationId).executeTakeFirst();
  const v = asObject(row?.attendance)['processingDelaySeconds'];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(3600, Math.floor(v)) : DEFAULT_PROCESSING_DELAY_SECONDS;
}

export const normalizeDedupeKey = (organizationId: string): string => `normalize:${organizationId}`;

/** Enqueue the normaliser for one organisation (called by the sweep, by ingestion, and by the normaliser itself to continue). */
export async function enqueueNormalizeRaw(queue: JobQueue, organizationId: string, opts: { continuation?: boolean; trx?: Trx } = {}): Promise<string> {
  return queue.enqueue({
    queue: 'processing',
    jobType: 'NORMALIZE_RAW',
    organizationId,
    payload: { organizationId },
    priority: 6,
    // a running job keeps its dedupe key until it completes, so a continuation needs its own key
    dedupeKey: opts.continuation ? `${normalizeDedupeKey(organizationId)}:next` : normalizeDedupeKey(organizationId),
    lockTimeoutSeconds: 600,
    maxAttempts: 3,
  }, opts.trx);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}
