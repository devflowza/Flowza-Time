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
 * pending seat of the level (Finance B-91: one row per call). `resolutionPath` and `createdAt` (when the row was written)
 * feed the extra-hand rule and the seat order used by `pendingSeats`.
 */
export interface ActorDecisionRow { userId: string; viaDelegationOf: string | null; onBehalfOfUserId?: string | null; decision: string; resolutionPath?: string | null; createdAt?: Date | string | null }

/** An approver added to an overdue level who has not decided yet: an extra pair of hands, not a seat of the level. */
export const isExtraHandRow = (r: { resolutionPath?: string | null; onBehalfOfUserId?: string | null }): boolean => r.resolutionPath === 'escalated' && !r.onBehalfOfUserId;

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

const writtenAt = (v: Date | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * SEAT ORDER, the one order of a level's seats wherever order matters: the engine's default seat for an override, the
 * request DTO's `pendingSeats`, the web's "Deciding for" list. Seats are ordered by when the seat's first row was written,
 * then by the seat's user id. A level's seats are all written by the submitting transaction, which gives them one
 * timestamp, so in practice they are ordered by user id; a seat written later (a reassignment) comes after them. The order
 * never depends on how the rows were read: not the physical row order, not a random row id (rows written by one statement
 * share their creation time — the review P2-13 follow-up). Extra hands are not seats and are never listed.
 */
export function seatOrder(rows: readonly ActorDecisionRow[]): string[] {
  const firstWritten = new Map<string, number>();
  for (const r of rows) {
    if (isExtraHandRow(r)) continue;
    const seat = seatOfRow(r);
    const at = writtenAt(r.createdAt);
    const seen = firstWritten.get(seat);
    if (seen === undefined || at < seen) firstWritten.set(seat, at);
  }
  return [...firstWritten.entries()].sort(([a, x], [b, y]) => x - y || (a < b ? -1 : a > b ? 1 : 0)).map(([seat]) => seat);
}

/**
 * The seats of a level still waiting for a decision, in seat order (`seatOrder`). An override or an escalated approver fills
 * one of these: the one the call names, or — only where `seatMustBeNamed` says the choice cannot matter — the first.
 */
export function pendingSeats(rows: readonly ActorDecisionRow[]): string[] {
  const seatRows = rows.filter((r) => !isExtraHandRow(r));
  return seatOrder(seatRows).filter((seat) => collapseSeats(seatRows.filter((r) => seatOfRow(r) === seat))[0] === 'PENDING');
}

/**
 * Must an override (or an escalated approver's decision) name the seat it fills? Yes when the level counts approvals (ALL
 * or QUORUM) and more than one seat is still waiting: which seat is filled decides who still has to act, so the engine
 * never picks one (Finance decides one named approver row per call). With ANY, or with a single waiting seat, the first
 * pending seat in seat order is the target, and it is deterministic.
 */
export function seatMustBeNamed(mode: ApprovalStepModeSpec, pendingSeatCount: number): boolean {
  return mode !== 'ANY' && pendingSeatCount > 1;
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
