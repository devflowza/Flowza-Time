import type { ApprovalDecideResultDto, ApprovalRequestDto, ApprovalSeatDto, ApprovalStepDto } from '@flowza/contracts';
import type { DecisionKind } from './api';

type T = (k: string, o?: Record<string, unknown>) => string;

/** "Any one approves", "All must approve", "2 of the approvers" — the rule of one level. */
export function modeText(t: T, step: Pick<ApprovalStepDto, 'mode' | 'requiredCount'>): string {
  return t(`mode.${step.mode}`, { count: step.requiredCount ?? 1 });
}

/** How a seat was resolved: "Manager", "Delegate", "Manager, level 2"… */
export function pathText(t: T, path: string | null): string {
  if (!path) return '';
  const chain = /^chain_step_(\d+)$/.exec(path);
  if (chain) return t('path.chain', { n: Number(chain[1]) });
  return t(`path.${path}`, { defaultValue: path });
}

/**
 * The seats of the current level still waiting, in the API's SEAT ORDER — the step's `pendingSeats` (when the seat was first
 * written, then the approver's user id): the list an override's seat is chosen from, the first being the API's default where
 * no choice is required (review P2-13). A payload without the field (an older API) is read from the actor rows instead: a
 * delegate or an override row stands for the seat it covers, an escalated approver who has not decided is an extra hand,
 * not a seat, and seats are ordered by the approver's id.
 */
export function waitingSeats(request: ApprovalRequestDto): ApprovalSeatDto[] {
  const step = request.steps.find((s) => s.stepNo === request.currentStep);
  if (!step) return [];
  if (step.pendingSeats) return step.pendingSeats;
  const seats = new Map<string, { name: string | null; pending: boolean; decided: boolean }>();
  for (const a of step.actors) {
    if (a.resolutionPath === 'escalated' && !a.onBehalfOfUserId) continue;
    const seat = a.onBehalfOfUserId ?? a.viaDelegationOf ?? a.userId;
    const name = a.onBehalfOfUserId ? (a.onBehalfOfName ?? null) : a.viaDelegationOf ? a.viaDelegationOfName : a.userName;
    const cur = seats.get(seat) ?? { name: null, pending: false, decided: false };
    seats.set(seat, { name: cur.name ?? name, pending: cur.pending || a.decision === 'PENDING', decided: cur.decided || a.decision === 'APPROVED' || a.decision === 'REJECTED' });
  }
  return [...seats.entries()].filter(([, s]) => s.pending && !s.decided).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([userId, s]) => ({ userId, userName: s.name }));
}


/** The toast after a decision says what actually happened: the whole request, this level, or only this approver's vote. */
export function decisionToast(t: (k: string) => string, res: ApprovalDecideResultDto, decision: DecisionKind, decidedStep: number): string {
  if (res.noop) return t('decision.noop');
  if (decision === 'REJECT') return res.terminal ? t('decision.rejected') : t('decision.rejectionRecorded');
  if (res.status === 'APPROVED') return t('decision.approved');
  return res.currentStep > decidedStep ? t('decision.stepApproved') : t('decision.approvalRecorded');
}
