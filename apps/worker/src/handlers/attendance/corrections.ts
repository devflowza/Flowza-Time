import { z } from 'zod';
import { uuidSchema } from '@flowza/contracts';
import { errors, event, localDateOf } from '@flowza/shared';
import { withContext, type JobQueue, type Trx } from '@flowza/database';
import type { HandlerRegistry, JobContext } from '../types.js';
import { enqueueRecompute, isoDate, parsePayload, type RecomputeReason } from './common.js';
import { isPeriodLocked } from './recompute.js';

export const applyCorrectionPayloadSchema = z.object({ organizationId: uuidSchema, correctionId: uuidSchema, appliedBy: uuidSchema.nullable().optional() });

export interface ApplyCorrectionOptions {
  /** Queue used for the immediate RECOMPUTE_DAILY (enqueued inside `trx`). */
  queue: JobQueue;
  /** User applying the correction (the approver); null for system. */
  appliedBy?: string | null;
  now?: Date;
}

export interface ApplyCorrectionResult {
  correctionId: string;
  status: 'APPLIED' | 'ALREADY_APPLIED';
  appliedEventId: string | null;
  voidedEventId: string | null;
  recomputeDates: string[];
}

/**
 * Apply an APPROVED correction (§G.1 step 4): events are never edited — ADD_PUNCH inserts a CORRECTION event, EDIT_PUNCH voids
 * the original and inserts the replacement, REMOVE_PUNCH voids, SET_STATUS stores nothing on events (the recompute applies the
 * override with the MANUAL_CORRECTION flag and a MANUAL_OVERRIDE history reason). The correction becomes APPLIED and an
 * immediate, deduped RECOMPUTE_DAILY is queued in the same transaction. Idempotent for already applied corrections.
 */
export async function applyApprovedCorrection(trx: Trx, correctionId: string, opts: ApplyCorrectionOptions): Promise<ApplyCorrectionResult> {
  const now = opts.now ?? new Date();
  const c = await trx.selectFrom('attendanceCorrections').selectAll().where('id', '=', correctionId).forUpdate().executeTakeFirst();
  if (!c) throw errors.notFound('Correction', correctionId);
  if (c.status === 'APPLIED') return { correctionId, status: 'ALREADY_APPLIED', appliedEventId: c.appliedEventId, voidedEventId: null, recomputeDates: [] };
  if (c.status !== 'APPROVED') throw errors.invalidState(`Correction is ${c.status}; only APPROVED corrections can be applied.`, { correctionId, status: c.status });
  const attendanceDate = isoDate(c.attendanceDate);
  if (await isPeriodLocked(trx, c.organizationId, c.branchId, attendanceDate)) throw errors.periodLocked();

  const branch = await trx.selectFrom('branches').select('timezone').where('id', '=', c.branchId).where('organizationId', '=', c.organizationId).executeTakeFirst();
  const tz = branch?.timezone ?? 'UTC';
  const dates = new Set<string>([attendanceDate]);
  let appliedEventId: string | null = null;
  let voidedEventId: string | null = null;
  let reason: RecomputeReason = 'CORRECTION';

  const insertEvent = async (punchedAt: Date, eventType: NonNullable<typeof c.proposedEventType>): Promise<string> => {
    const row = await trx.insertInto('attendanceEvents').values({
      organizationId: c.organizationId, employeeId: c.employeeId, branchId: c.branchId, deviceId: null, rawTransactionId: null, source: 'CORRECTION', eventType, punchedAt,
      verificationMethod: 'manual', correctionId: c.id, note: c.reason, createdBy: opts.appliedBy ?? c.requestedBy ?? null,
    }).returning('id').executeTakeFirstOrThrow();
    dates.add(localDateOf(punchedAt, tz));
    return row.id;
  };
  const voidOriginal = async (): Promise<void> => {
    if (!c.originalEventId) throw errors.validation('Correction has no original event.', { correctionId });
    const original = await trx.selectFrom('attendanceEvents').select(['id', 'punchedAt', 'eventType', 'voidedAt', 'employeeId'])
      .where('organizationId', '=', c.organizationId).where('id', '=', c.originalEventId).executeTakeFirst();
    if (!original) throw errors.notFound('Attendance event', c.originalEventId);
    if (original.employeeId !== c.employeeId) throw errors.invalidState('Original event belongs to another employee.', { correctionId });
    if (original.voidedAt) throw errors.invalidState('Original event is already voided.', { correctionId, eventId: original.id });
    await trx.updateTable('attendanceEvents').set({ voidedAt: now, voidedByCorrectionId: c.id }).where('id', '=', original.id).where('organizationId', '=', c.organizationId).execute();
    voidedEventId = original.id;
    dates.add(localDateOf(original.punchedAt instanceof Date ? original.punchedAt : new Date(original.punchedAt), tz));
    if (c.type === 'EDIT_PUNCH') {
      if (!c.proposedPunchedAt) throw errors.validation('EDIT_PUNCH needs proposedPunchedAt.', { correctionId });
      appliedEventId = await insertEvent(c.proposedPunchedAt instanceof Date ? c.proposedPunchedAt : new Date(c.proposedPunchedAt), c.proposedEventType ?? original.eventType);
    }
  };

  switch (c.type) {
    case 'ADD_PUNCH': {
      if (!c.proposedPunchedAt) throw errors.validation('ADD_PUNCH needs proposedPunchedAt.', { correctionId });
      appliedEventId = await insertEvent(c.proposedPunchedAt instanceof Date ? c.proposedPunchedAt : new Date(c.proposedPunchedAt), c.proposedEventType ?? 'PUNCH');
      break;
    }
    case 'EDIT_PUNCH':
    case 'REMOVE_PUNCH':
      await voidOriginal();
      break;
    case 'SET_STATUS':
      if (!c.proposedStatus) throw errors.validation('SET_STATUS needs proposedStatus.', { correctionId });
      reason = 'MANUAL_OVERRIDE';
      break;
    default: {
      const exhaustive: never = c.type;
      throw errors.validation(`Unknown correction type ${String(exhaustive)}.`);
    }
  }

  await trx.updateTable('attendanceCorrections').set({ status: 'APPLIED', appliedEventId, appliedAt: now, appliedBy: opts.appliedBy ?? null }).where('id', '=', c.id).execute();
  const recomputeDates = [...dates].sort();
  for (const date of recomputeDates) await enqueueRecompute(opts.queue, { organizationId: c.organizationId, employeeId: c.employeeId, date, reason, runAt: now, triggeredBy: opts.appliedBy ?? null }, trx);
  return { correctionId, status: 'APPLIED', appliedEventId, voidedEventId, recomputeDates };
}

/** APPLY_CORRECTION handler: payload `{ organizationId, correctionId, appliedBy? }`. */
export async function applyCorrectionHandler({ job, deps, log }: JobContext) {
  const p = parsePayload(applyCorrectionPayloadSchema, job.payload);
  const res = await withContext(deps.db, { kind: 'system', organizationId: p.organizationId, jobId: job.id }, async (trx) => {
    const c = await trx.selectFrom('attendanceCorrections').select('organizationId').where('id', '=', p.correctionId).executeTakeFirst();
    if (!c || c.organizationId !== p.organizationId) throw errors.notFound('Correction', p.correctionId);
    return applyApprovedCorrection(trx, p.correctionId, { queue: deps.queue, appliedBy: p.appliedBy ?? null, now: deps.now() });
  });
  log.info(event('attendance_correction_applied', { ...res }));
  return res;
}

export function registerCorrectionHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'APPLY_CORRECTION', handler: applyCorrectionHandler, timeoutMs: 60_000 });
}
