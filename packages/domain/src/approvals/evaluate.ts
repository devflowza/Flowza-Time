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

/**
 * One actor row as the level's evaluation sees it. `onBehalfOfUserId` names the seat a decision was taken FOR when the
 * decider did not hold it themselves: an organisation-wide approver's override or an escalated approver fills exactly one
 * pending seat of the level (Finance B-91: one row per call).
 */
export interface ActorDecisionRow { userId: string; viaDelegationOf: string | null; onBehalfOfUserId?: string | null; decision: string }

/** The seat a row decides for: the seat named on an override / escalation, else the approver a delegate covers, else the person. */
export const seatOfRow = (r: { userId: string; viaDelegationOf: string | null; onBehalfOfUserId?: string | null }): string => r.onBehalfOfUserId ?? r.viaDelegationOf ?? r.userId;

/**
 * Collapse actor rows into one decision per seat: a delegate's decision counts for the approver they act for, and an
 * override / escalated decision for the seat it names. A seat is APPROVED when anybody in it approved, REJECTED when
 * somebody rejected and nobody approved, otherwise PENDING. Seats whose rows were all skipped no longer count.
 */
export function collapseSeats(rows: readonly ActorDecisionRow[]): SeatDecision[] {
  const seats = new Map<string, SeatDecision | null>();
  for (const r of rows) {
    const seat = seatOfRow(r);
    const current = seats.get(seat) ?? null;
    const next: SeatDecision | null = r.decision === 'APPROVED' ? 'APPROVED' : r.decision === 'REJECTED' ? 'REJECTED' : r.decision === 'PENDING' ? 'PENDING' : null;
    if (next === null) { if (!seats.has(seat)) seats.set(seat, null); continue; }
    if (current === 'APPROVED' || next === 'APPROVED') seats.set(seat, 'APPROVED');
    else if (current === 'REJECTED' || next === 'REJECTED') seats.set(seat, 'REJECTED');
    else seats.set(seat, 'PENDING');
  }
  return [...seats.values()].filter((d): d is SeatDecision => d !== null);
}

/**
 * The seats of a level still waiting for a decision, in seat order (the order their first row was written, i.e. the order
 * resolution seated them). An override or an escalated approver fills the first of these unless the call names one.
 */
export function pendingSeats(rows: readonly ActorDecisionRow[]): string[] {
  const order: string[] = [];
  const state = new Map<string, SeatDecision | null>();
  for (const r of rows) {
    const seat = seatOfRow(r);
    if (!state.has(seat)) order.push(seat);
    const [decision] = collapseSeats(rows.filter((x) => seatOfRow(x) === seat));
    state.set(seat, decision ?? null);
  }
  return order.filter((s) => state.get(s) === 'PENDING');
}

/**
 * The number of approvals a level needs after its pending seats were handed to ONE new approver (reassignment, Finance
 * B-104). The seats that already approved still count; the reassignee is the only pending seat left, so the requirement
 * becomes `min(required, approvals already given + 1)` — their approval always completes the level and can never turn into
 * a rejection because the original quorum is out of reach. ALL keeps no count (every remaining seat must approve, which the
 * reassignee's approval completes). ANY stays 1.
 */
export function requiredAfterReassign(mode: ApprovalStepModeSpec, requiredCount: number | null | undefined, approvedSeats: number): number | null {
  if (mode === 'ALL') return null;
  const required = mode === 'ANY' ? 1 : Math.max(1, Math.floor(requiredCount ?? 1));
  return Math.max(1, Math.min(required, approvedSeats + 1));
}

/** When an activated level escalates, or null when the step has no escalation. */
export function escalationDueAt(step: { escalateAfterHours?: number | null | undefined; escalateTo?: string | null | undefined }, activatedAt: Date): Date | null {
  if (!step.escalateAfterHours || !step.escalateTo) return null;
  return new Date(activatedAt.getTime() + step.escalateAfterHours * 3_600_000);
}
