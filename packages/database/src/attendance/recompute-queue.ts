import { z } from 'zod';
import { isoDateSchema, uuidSchema } from '@flowza/contracts';
import type { Trx } from '../context.js';
import type { JobQueue } from '../queue.js';
import type { RecordHistoryReason } from '../generated/db.js';

/**
 * The RECOMPUTE_DAILY contract shared by every writer of an (employee, date) — the worker's normaliser and correction
 * handlers, and the API / worker flows that write day marks or charge a pay effect (HR portal Prompt 3). One place for
 * the payload shape and the dedupe key, so a job enqueued from the API coalesces with one the worker enqueued.
 */

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

/**
 * Reasons whose recompute must run now. They get their own dedupe key so a debounced NEW_EVENT job that is already
 * pending (with a later `runAt` and the wrong reason) cannot absorb them — both jobs are idempotent, the later one is a no-op.
 */
export const IMMEDIATE_RECOMPUTE_REASONS: ReadonlySet<RecomputeReason> = new Set<RecomputeReason>(['CORRECTION', 'MANUAL_OVERRIDE', 'UNLOCK']);
export const recomputeDedupeKey = (employeeId: string, date: string, immediate = false): string => `recompute:${employeeId}:${date}${immediate ? ':immediate' : ''}`;

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
 * already pending keeps its original `runAt` (jobs.enqueue returns the existing id). Inside `trx` the job commits with the
 * state change that needs it (AGENTS.md rule 5).
 */
export async function enqueueRecompute(queue: JobQueue, input: EnqueueRecomputeInput, trx?: Trx): Promise<string> {
  const reason = input.reason ?? 'NEW_EVENT';
  const immediate = IMMEDIATE_RECOMPUTE_REASONS.has(reason);
  const payload: Record<string, unknown> = { organizationId: input.organizationId, employeeId: input.employeeId, date: input.date, reason };
  if (input.bypassLock) payload['bypassLock'] = true;
  if (input.triggeredBy) payload['triggeredBy'] = input.triggeredBy;
  return queue.enqueue({
    queue: 'processing',
    jobType: 'RECOMPUTE_DAILY',
    organizationId: input.organizationId,
    payload,
    priority: immediate ? 7 : 5,
    runAt: input.runAt ?? new Date(),
    dedupeKey: recomputeDedupeKey(input.employeeId, input.date, immediate),
    lockTimeoutSeconds: 120,
    maxAttempts: 5,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  }, trx);
}
