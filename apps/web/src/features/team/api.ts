import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TeamAttendanceRowDto, TeamLeaveOverviewDto, TeamPendingCountsDto, TeamSummaryDto } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { meQueryKey, useActiveMembership, useCan, useModuleEnabled, useOrgId } from '@/features/me/use-me';

/** Query-key entities of the team workspace (HR portal Prompt 5); the approvals views invalidate them after a decision. */
export const TEAM_SUMMARY = 'team-summary';
export const TEAM_ATTENDANCE = 'team-attendance';
export const TEAM_LEAVE = 'team-leave';
export const TEAM_PENDING = 'team-pending-counts';
export const TEAM_ENTITIES = [TEAM_SUMMARY, TEAM_ATTENDANCE, TEAM_LEAVE, TEAM_PENDING] as const;

/**
 * Who sees what of the team workspace. The menu entry is for a member with direct reports AND a key that reads them (a team
 * key — employee / attendance / leave .view_team — or an organisation-wide one): the team is the reporting RELATIONSHIP, so a
 * key alone (an HR admin holding attendance.view_team without reports) would only ever open an empty workspace. Each tab asks
 * the API with its own key (attendance / leave), which re-checks the relationship; RLS applies it again. The badge chip is for
 * managers and approvers (and a delegate with something waiting). A line manager without an approve key works their
 * approvals on /team (Finance B-66).
 */
export function useTeamAccess() {
  const can = useCan();
  const m = useActiveMembership();
  const hasReports = m?.isManager ?? false;
  // the workspace is the Manager workspace module, its leave tab also Leave management (migration 20260929000600)
  const workspaceOn = useModuleEnabled('manager_workspace');
  const leaveOn = useModuleEnabled('leave');
  const attendance = can('attendance.view_team') || can('attendance.view');
  const leave = leaveOn && (can('leave.view_team') || can('leave.view'));
  const teamKey = can('employee.view_team') || can('attendance.view_team') || can('leave.view_team');
  const approver = can('attendance.approve') || can('leave.approve');
  const signal = m?.approvals as { actionable?: number; delegatedToMe?: boolean } | undefined;
  const waiting = (signal?.actionable ?? 0) > 0 || signal?.delegatedToMe === true;
  return {
    hasReports,
    attendance,
    leave,
    approver,
    page: workspaceOn && hasReports && (teamKey || can('employee.view') || attendance || leave),
    pendingChip: hasReports || approver || can('approval.manage') || can('attendance.review_notes') || waiting,
    approvalsHome: approver || !hasReports ? '/approvals' : '/team?tab=approvals',
    correct: can('attendance.correct'),
    delegate: can('approval.delegate') || can('approval.manage'),
  };
}

export function useTeamSummary(date: string | undefined, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, TEAM_SUMMARY, { date: date ?? null }),
    queryFn: async () => (await api.get<Envelope<TeamSummaryDto>>(`/orgs/${orgId}/team/summary`, date ? { date } : undefined)).data,
    refetchInterval: 60_000, enabled,
  });
}

export interface TeamAttendanceQuery { from: string; to: string; employeeId?: string | undefined; page: number; pageSize: number }
export function useTeamAttendance(query: TeamAttendanceQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, TEAM_ATTENDANCE, query),
    queryFn: () => api.get<PageEnvelope<TeamAttendanceRowDto>>(`/orgs/${orgId}/team/attendance`, { ...query, employeeId: query.employeeId || undefined }),
    placeholderData: keepPreviousData, enabled,
  });
}

export function useTeamLeave(from: string, to: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, TEAM_LEAVE, { from, to }), queryFn: async () => (await api.get<Envelope<TeamLeaveOverviewDto>>(`/orgs/${orgId}/team/leave`, { from, to })).data, placeholderData: keepPreviousData, enabled });
}

/** The manager badge (Finance B-63): refreshed every minute and whenever the window regains focus. */
export function usePendingCounts(enabled = true) {
  const orgId = useActiveMembership()?.organization.id ?? null;
  return useQuery({
    queryKey: qk.list(orgId ?? 'none', TEAM_PENDING, {}),
    queryFn: async () => (await api.get<Envelope<TeamPendingCountsDto>>(`/orgs/${orgId}/team/pending-counts`)).data,
    refetchInterval: 60_000, refetchOnWindowFocus: true, retry: false, enabled: enabled && !!orgId,
  });
}

/** A decision on /team moves the board, the counts and /me (its approvals.actionable). */
export function useInvalidateTeam() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => {
    for (const e of TEAM_ENTITIES) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) });
    void qc.invalidateQueries({ queryKey: meQueryKey });
  };
}
