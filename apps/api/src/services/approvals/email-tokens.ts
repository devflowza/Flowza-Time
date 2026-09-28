import type { ApprovalDecision } from '@flowza/contracts';
import { hashApprovalToken } from '@flowza/database';
import { AppError, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requireMembership } from '../../lib/authorize.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import { systemStep } from '../features/context.js';
import { decideWithin, type DecideOutcome } from './engine.js';

/**
 * One-click decisions from e-mail (B-101). The worker mints a pair of tokens (approve / reject) per recipient when it
 * sends an `approval.pending` mail; only the sha256 hash is stored, the token lives 7 days and is single-use. The link
 * lands on the web app, which POSTs it here with the caller's session — so the token must belong to the SIGNED-IN user
 * (a forwarded link is worthless to somebody else) and every rule of `decideWithin` still applies (SoD, current step,
 * comment on reject). A link decides the SEAT it was minted for — never an organisation-wide override (review P1-2).
 * Consumption and the decision share one transaction: a failed decision leaves the token unused. A failed attempt is
 * audited on its own (never the token: a short prefix of its hash identifies the link — review P2-6); the route puts a
 * dedicated per-IP and per-user limiter in front of it.
 */
export async function redeemEmailToken(deps: ApiDeps, actor: Actor, orgId: string, input: { token: string; action: ApprovalDecision; comment?: string | undefined }): Promise<DecideOutcome> {
  requireMembership(actor.principal, orgId);
  const tokenHash = hashApprovalToken(input.token);
  let requestId: string | null = null;
  try {
    return await runUser(deps.db, actor, async (trx) => {
      const token = await systemStep(trx, orgId, async (t) => {
        const row = await t.selectFrom('approvalEmailTokens').selectAll().where('organizationId', '=', orgId).where('tokenHash', '=', tokenHash).forUpdate().executeTakeFirst();
        if (!row || row.userId !== actor.userId) throw errors.notFound('Approval link', 'token');
        requestId = row.requestId;
        if (row.usedAt) throw errors.invalidState('This approval link has already been used.');
        if (row.expiresAt.getTime() <= Date.now()) throw errors.invalidState('This approval link has expired; open the request in the app instead.');
        if (row.action !== input.action) throw errors.validation('The link does not match the requested action.');
        const step = await t.selectFrom('approvalSteps').select(['stepNo', 'requestId']).where('id', '=', row.stepId).executeTakeFirst();
        if (!step) throw errors.notFound('Approval request', row.requestId);
        // consumed with the decision: a refused decision rolls the whole transaction back and leaves the link usable
        await t.updateTable('approvalEmailTokens').set({ usedAt: new Date() }).where('id', '=', row.id).execute();
        // the sibling (the other action's token for the same step and recipient) is spent with it
        await t.updateTable('approvalEmailTokens').set({ usedAt: new Date() }).where('stepId', '=', row.stepId).where('userId', '=', row.userId).where('usedAt', 'is', null).execute();
        return { ...row, stepNo: step.stepNo };
      });
      const outcome = await decideWithin(deps, trx, actor, orgId, token.requestId, { stepNo: token.stepNo, decision: input.action, comment: input.comment ?? (input.action === 'REJECT' ? 'Rejected from e-mail' : undefined), viaEmailToken: true, requireSeat: true });
      await audit(trx, actor, orgId, 'approval.email_token_used', 'approval_request', { entityId: token.requestId, branchId: outcome.branchId, newValue: { action: input.action, stepNo: token.stepNo } });
      return outcome;
    });
  } catch (err) {
    if (err instanceof AppError) {
      // its own transaction: the attempt's transaction rolled back. Never the token — 8 hex characters of its hash.
      const failedRequestId: string | null = requestId;
      await runUser(deps.db, actor, (trx) => audit(trx, actor, orgId, 'approval.email_token_failed', 'approval_request', {
        entityId: failedRequestId,
        newValue: { tokenHashPrefix: tokenHash.slice(0, 8), action: input.action, code: err.code },
      })).catch(() => undefined);
    }
    throw err;
  }
}
