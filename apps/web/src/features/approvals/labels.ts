import type { ApprovalDecideResultDto, ApprovalRequestDto, ApprovalStepDto } from '@flowza/contracts';
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
 * The seat an override or an escalated approver's decision fills when the call names none: the first approver of the level
 * still waiting (the API's own default — review P0-1 / P2-13). A delegate row stands for the approver it covers; an
 * escalated approver who has not decided is an extra hand, not a seat.
 */
export function firstWaitingSeatName(request: ApprovalRequestDto): string | null {
  const step = request.steps.find((s) => s.stepNo === request.currentStep);
  const row = step?.actors.find((a) => a.decision === 'PENDING' && !(a.resolutionPath === 'escalated' && !a.onBehalfOfUserId));
  if (!row) return null;
  return row.viaDelegationOf ? (row.viaDelegationOfName ?? null) : (row.userName ?? null);
}

/** The toast after a decision says what actually happened: the whole request, this level, or only this approver's vote. */
export function decisionToast(t: (k: string) => string, res: ApprovalDecideResultDto, decision: DecisionKind, decidedStep: number): string {
  if (res.noop) return t('decision.noop');
  if (decision === 'REJECT') return res.terminal ? t('decision.rejected') : t('decision.rejectionRecorded');
  if (res.status === 'APPROVED') return t('decision.approved');
  return res.currentStep > decidedStep ? t('decision.stepApproved') : t('decision.approvalRecorded');
}
