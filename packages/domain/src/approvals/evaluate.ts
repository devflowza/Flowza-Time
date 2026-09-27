import type { ApprovalStepModeSpec, LevelOutcome, SeatDecision } from './types.js';

/**
 * Is a level done? ALL: every seat must approve and one rejection is terminal. ANY: one approval; QUORUM: `requiredCount`
 * approvals. Under ANY/QUORUM a rejection is terminal only when the remaining approvals can no longer reach the
 * requirement (Finance B-94) — until then the request stays open and the rejection is recorded on the actor's row.
 */
export function evaluateLevel(mode: ApprovalStepModeSpec, requiredCount: number | null | undefined, decisions: readonly SeatDecision[]): LevelOutcome {
  const total = decisions.length;
  if (total === 0) return 'open';
  const approved = decisions.filter((d) => d === 'APPROVED').length;
  const rejected = decisions.filter((d) => d === 'REJECTED').length;
  const pending = total - approved - rejected;
  if (mode === 'ALL') {
    if (rejected > 0) return 'rejected';
    return approved === total ? 'satisfied' : 'open';
  }
  const required = mode === 'ANY' ? 1 : Math.max(1, Math.floor(requiredCount ?? 1));
  if (approved >= required) return 'satisfied';
  if (approved + pending < required) return 'rejected';
  return 'open';
}

export interface ActorDecisionRow { userId: string; viaDelegationOf: string | null; decision: string }

/**
 * Collapse actor rows into one decision per seat: a delegate's decision counts for the approver they act for. A seat is
 * APPROVED when anybody in it approved, REJECTED when somebody rejected and nobody approved, otherwise PENDING. Seats
 * whose rows were all skipped no longer count.
 */
export function collapseSeats(rows: readonly ActorDecisionRow[]): SeatDecision[] {
  const seats = new Map<string, SeatDecision | null>();
  for (const r of rows) {
    const seat = r.viaDelegationOf ?? r.userId;
    const current = seats.get(seat) ?? null;
    const next: SeatDecision | null = r.decision === 'APPROVED' ? 'APPROVED' : r.decision === 'REJECTED' ? 'REJECTED' : r.decision === 'PENDING' ? 'PENDING' : null;
    if (next === null) { if (!seats.has(seat)) seats.set(seat, null); continue; }
    if (current === 'APPROVED' || next === 'APPROVED') seats.set(seat, 'APPROVED');
    else if (current === 'REJECTED' || next === 'REJECTED') seats.set(seat, 'REJECTED');
    else seats.set(seat, 'PENDING');
  }
  return [...seats.values()].filter((d): d is SeatDecision => d !== null);
}

/** When an activated level escalates, or null when the step has no escalation. */
export function escalationDueAt(step: { escalateAfterHours?: number | null | undefined; escalateTo?: string | null | undefined }, activatedAt: Date): Date | null {
  if (!step.escalateAfterHours || !step.escalateTo) return null;
  return new Date(activatedAt.getTime() + step.escalateAfterHours * 3_600_000);
}
