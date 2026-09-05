import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { isoDateSchema, uuidSchema } from '@flowza/contracts';
import { errors } from '@flowza/shared';
import type { JobQueue, RecordHistoryReason, Trx } from '@flowza/database';

/** Reasons a recompute job may carry (mirrors `public.record_history_reason`). */
export const RECOMPUTE_REASONS = ['NEW_EVENT', 'CORRECTION', 'RULE_CHANGE', 'SHIFT_CHANGE', 'HOLIDAY_CHANGE', 'LEAVE_CHANGE', 'RECALCULATION', 'MANUAL_OVERRIDE', 'UNLOCK'] as const satisfies readonly RecordHistoryReason[];
export const recomputeReasonSchema = z.enum(RECOMPUTE_REASONS);
export type RecomputeReason = z.infer<typeof recomputeReasonSchema>;

export const recomputePayloadSchema = z.object({
  organizationId: uuidSchema,
  employeeId: uuidSchema,
  date: isoDateSchema,
  reason: recomputeReasonSchema.default('NEW_EVENT'),
  bypassLock: z.boolean().default(false),
  triggeredBy: uuidSchema.nullable().optional(),
});
export type RecomputePayload = z.infer<typeof recomputePayloadSchema>;

export const DEFAULT_PROCESSING_DELAY_SECONDS = 30;

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

export const recomputeDedupeKey = (employeeId: string, date: string): string => `recompute:${employeeId}:${date}`;
export const normalizeDedupeKey = (organizationId: string): string => `normalize:${organizationId}`;

export interface EnqueueRecomputeInput {
  organizationId: string;
  employeeId: string;
  date: string;
  reason?: RecomputeReason;
  runAt?: Date;
  bypassLock?: boolean;
  triggeredBy?: string | null;
  correlationId?: string;
}

/**
 * Enqueue one debounced RECOMPUTE_DAILY per (employee, date). The dedupe key coalesces bursts of punches; a job that is
 * already pending keeps its original `runAt` (jobs.enqueue returns the existing id).
 */
export async function enqueueRecompute(queue: JobQueue, input: EnqueueRecomputeInput, trx?: Trx): Promise<string> {
  const payload: Record<string, unknown> = { organizationId: input.organizationId, employeeId: input.employeeId, date: input.date, reason: input.reason ?? 'NEW_EVENT' };
  if (input.bypassLock) payload['bypassLock'] = true;
  if (input.triggeredBy) payload['triggeredBy'] = input.triggeredBy;
  return queue.enqueue({
    queue: 'processing',
    jobType: 'RECOMPUTE_DAILY',
    organizationId: input.organizationId,
    payload,
    priority: input.reason === 'CORRECTION' || input.reason === 'MANUAL_OVERRIDE' ? 7 : 5,
    runAt: input.runAt ?? new Date(),
    dedupeKey: recomputeDedupeKey(input.employeeId, input.date),
    lockTimeoutSeconds: 120,
    maxAttempts: 5,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  }, trx);
}

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
