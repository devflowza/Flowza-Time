import { usePendingCounts, useTeamAccess } from './api';
import { TEAM_NS } from './i18n';

/**
 * THE "waiting for you" number (HR portal Prompt 5 review, P2-3) — one figure shared by the topbar chip, the sidebar badge of
 * Approvals, the dashboard KPI tile and the "Awaiting your approval" widget: `team/pending-counts.total`, i.e.
 *   - the approval requests waiting for the member on their CURRENT level — the engine's own definition
 *     (`app.approval_actionable_request_ids`, the same set as /me.approvals.actionable and the inbox "Mine" queue): their own
 *     seat, a stand-in seat of the reporting line (secondary manager), a delegate seat in force today, an escalation seat;
 *     never a request about them, one they filed reached only as a delegate, or a level after one they approved;
 *   - plus the attendance reasons with no live request that they review as the mapped line manager.
 * Requests on which an approver asked the employee for more information STAY counted (a documented decision, review O2): the
 * level is still waiting for its approvers, and the question can be withdrawn or the request decided at any time.
 */
export function useWaitingForYou(enabled?: boolean) {
  const access = useTeamAccess();
  const on = enabled ?? access.pendingChip;
  const q = usePendingCounts(on);
  const approvals = q.data?.approvals ?? 0;
  const notes = q.data?.notes ?? 0;
  const total = q.data?.total ?? 0;
  // only reasons waiting: a line manager reviews them on /team, anybody else on the review page
  const to = approvals === 0 && notes > 0 ? (access.hasReports ? '/team?tab=approvals' : '/attendance/notes') : access.approvalsHome;
  return { enabled: on, loaded: !!q.data, total, approvals, notes, to };
}

/** The breakdown of the number (review P2-6): each half pluralised, a half that is zero left out. */
export function waitingBreakdown(t: (key: string, options: { count: number }) => string, counts: { approvals: number; notes: number }): string {
  return [
    counts.approvals > 0 ? t(`${TEAM_NS}:chip.approvals`, { count: counts.approvals }) : null,
    counts.notes > 0 ? t(`${TEAM_NS}:chip.notes`, { count: counts.notes }) : null,
  ].filter((x): x is string => !!x).join(' · ');
}
