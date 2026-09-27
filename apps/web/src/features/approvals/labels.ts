import type { ApprovalDecideResultDto, ApprovalStepDto } from '@flowza/contracts';
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

/** The toast after a decision says what actually happened: the whole request, this level, or only this approver's vote. */
export function decisionToast(t: (k: string) => string, res: ApprovalDecideResultDto, decision: DecisionKind, decidedStep: number): string {
  if (res.noop) return t('decision.noop');
  if (decision === 'REJECT') return res.terminal ? t('decision.rejected') : t('decision.rejectionRecorded');
  if (res.status === 'APPROVED') return t('decision.approved');
  return res.currentStep > decidedStep ? t('decision.stepApproved') : t('decision.approvalRecorded');
}
