import { createHash, randomBytes } from 'node:crypto';
import type { Trx } from './context.js';

/** One-click e-mail actions: 256-bit random tokens, only their sha256 stored, 7-day expiry, single use (Finance B-101). */
export const APPROVAL_EMAIL_TOKEN_TTL_DAYS = 7;

export function hashApprovalToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface ApprovalEmailTokenPair { approve: string; reject: string; expiresAt: Date }

/**
 * Mint the approve/reject tokens one recipient receives for one pending step. Runs inside a system-for-org transaction
 * (the table is never client-readable). The raw tokens exist only in the e-mail; the database keeps their hashes.
 */
export async function issueApprovalEmailTokens(trx: Trx, input: { organizationId: string; requestId: string; stepId: string; userId: string }, opts: { now?: Date; ttlDays?: number } = {}): Promise<ApprovalEmailTokenPair> {
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (opts.ttlDays ?? APPROVAL_EMAIL_TOKEN_TTL_DAYS) * 86_400_000);
  const approve = randomBytes(32).toString('base64url');
  const reject = randomBytes(32).toString('base64url');
  await trx.insertInto('approvalEmailTokens').values([
    { organizationId: input.organizationId, requestId: input.requestId, stepId: input.stepId, userId: input.userId, action: 'APPROVE', tokenHash: hashApprovalToken(approve), expiresAt },
    { organizationId: input.organizationId, requestId: input.requestId, stepId: input.stepId, userId: input.userId, action: 'REJECT', tokenHash: hashApprovalToken(reject), expiresAt },
  ]).execute();
  return { approve, reject, expiresAt };
}
