import { z } from 'zod';
import { isoDateSchema, uuidSchema } from '@flowza/contracts';
import { event } from '@flowza/shared';
import { emitDomainEvent, expireCompOffCredits, withContext, writeAudit, type Trx } from '@flowza/database';
import type { JobContext } from '../types.js';
import { parsePayload } from '../attendance/common.js';
import { orgLocalDate } from '../attendance/day-close.js';

/**
 * Comp-off expiry sweep (leave v2, Finance parity B-60): approved or partly used credits whose `expires_on` is before the
 * organisation's local date become `expired` — their unused days leave the comp-off balance (the balance function already
 * ignores them from that day; the sweep makes the credit list say so). The employee hears about it once per sweep
 * (`leave.comp_off_expired`). Idempotent: an expired credit is never touched again.
 */
export const compOffExpiryPayloadSchema = z.object({ organizationId: uuidSchema, asOf: isoDateSchema.optional() });
export type CompOffExpiryPayload = z.infer<typeof compOffExpiryPayloadSchema>;

export interface CompOffExpirySummary { asOf: string; expired: number; employees: number; days: number }

export async function runCompOffExpiry(trx: Trx, p: CompOffExpiryPayload, now: Date, jobId: string | null): Promise<CompOffExpirySummary> {
  const asOf = p.asOf ?? await orgLocalDate(trx, p.organizationId, now);
  const touched = await expireCompOffCredits(trx, p.organizationId, asOf);
  const byEmployee = new Map<string, typeof touched>();
  for (const c of touched) byEmployee.set(c.employeeId, [...(byEmployee.get(c.employeeId) ?? []), c]);
  const summary: CompOffExpirySummary = { asOf, expired: touched.length, employees: byEmployee.size, days: Math.round(touched.reduce((a, c) => a + c.remainingDays, 0) * 2) / 2 };
  if (!touched.length) return summary;
  for (const [employeeId, credits] of byEmployee) {
    const days = Math.round(credits.reduce((a, c) => a + c.remainingDays, 0) * 2) / 2;
    const logins = await trx.selectFrom('orgMemberships').select('userId').where('organizationId', '=', p.organizationId).where('employeeId', '=', employeeId).where('status', '=', 'active').execute();
    await emitDomainEvent(trx, {
      organizationId: p.organizationId, eventType: 'leave.comp_off_expired', aggregateType: 'employee', aggregateId: employeeId,
      payload: { employeeId, credits: credits.length, days, expiredOn: asOf, ...(logins[0] ? { userId: logins[0].userId } : {}) }, actorUserId: null,
    });
  }
  await writeAudit(trx, { organizationId: p.organizationId, actorUserId: null, action: 'comp_off.expired', entityType: 'comp_off_credit', entityId: null, newValue: { ...summary, creditIds: touched.map((c) => c.id) }, jobId });
  return summary;
}

/** LEAVE_COMP_OFF_EXPIRY handler: one organisation per job, in its system context. */
export async function compOffExpiryHandler({ job, deps, log }: JobContext) {
  const p = parsePayload(compOffExpiryPayloadSchema, job.payload);
  const res = await withContext(deps.db, { kind: 'system', organizationId: p.organizationId, jobId: job.id }, (trx) => runCompOffExpiry(trx, p, deps.now(), job.id));
  log.info(event('leave_comp_off_expired', { organizationId: p.organizationId, ...res }));
  return res;
}
