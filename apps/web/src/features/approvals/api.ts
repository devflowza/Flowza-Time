import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDecideResultDto, ApprovalDelegationDto, ApprovalDelegationInput, ApprovalEntity, ApprovalInboxScope, ApprovalRequestDto, ApprovalWorkflowDto, ApprovalWorkflowInput } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useActiveMembership, useCan, useOrgId } from '@/features/me/use-me';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type { ApprovalRequestDto, ApprovalWorkflowDto, ApprovalDelegationDto };
export type InboxView = 'pending' | 'history';
export type DecisionKind = 'APPROVE' | 'REJECT';

/** Query-key entities of the approvals feature; every mutation invalidates all of them plus the documents behind them. */
const INBOX = 'approvals-inbox';
const REQUEST = 'approval-request';
const MINE = 'approvals-mine';
const DOCUMENTS = ['attendance-corrections', 'attendance-records', 'attendance-daily', 'attendance-monthly', 'leave-records', 'self-service'];
/** Everything a decision can move: the approval views, the documents behind them and the dashboard (its pending count). */
export function invalidateApprovalViews(qc: ReturnType<typeof useQueryClient>, orgId: string) {
  for (const e of [INBOX, REQUEST, MINE, ...DOCUMENTS]) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) });
  void qc.invalidateQueries({ queryKey: ['dashboard', orgId] });
}

export interface InboxQuery { scope: ApprovalInboxScope; view: InboxView; entityType?: ApprovalEntity | undefined; page: number; pageSize: number }

export function useApprovalInbox(query: InboxQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, INBOX, query), queryFn: () => api.get<PageEnvelope<ApprovalRequestDto>>(`/orgs/${orgId}/approvals`, { ...query, entityType: query.entityType || undefined }), placeholderData: keepPreviousData, refetchInterval: 60_000, enabled });
}
export function useApprovalRequest(id: string | null) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, REQUEST, id ?? ''), queryFn: async () => (await api.get<Envelope<ApprovalRequestDto>>(`/orgs/${orgId}/approvals/${id}`)).data, enabled: !!id });
}
/** Requests I filed or that are about me (portal). */
export function useMyApprovalRequests(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, MINE, query), queryFn: () => api.get<PageEnvelope<ApprovalRequestDto>>(`/orgs/${orgId}/approvals/mine`, query), placeholderData: keepPreviousData, enabled });
}

export function useApprovalMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => invalidateApprovalViews(qc, orgId);
  const post = async <T,>(path: string, body: unknown) => (await api.post<Envelope<T>>(`/orgs/${orgId}/approvals/${path}`, body)).data;
  const decide = useMutation({ mutationFn: ({ requestId, stepNo, decision, comment }: { requestId: string; stepNo?: number; decision: DecisionKind; comment?: string }) => post<ApprovalDecideResultDto>(`${requestId}/decide`, { stepNo, decision, comment: comment || undefined }), onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: ({ requestId, reason }: { requestId: string; reason?: string }) => post<ApprovalRequestDto>(`${requestId}/cancel`, { reason: reason || undefined }), onSuccess: invalidate });
  const reassign = useMutation({ mutationFn: ({ requestId, userId, reason, stepNo }: { requestId: string; userId: string; reason: string; stepNo?: number }) => post<ApprovalRequestDto>(`${requestId}/reassign`, { userId, reason, stepNo }), onSuccess: invalidate });
  const requestInfo = useMutation({ mutationFn: ({ requestId, comment }: { requestId: string; comment: string }) => post<ApprovalRequestDto>(`${requestId}/request-info`, { comment }), onSuccess: invalidate });
  const answerInfo = useMutation({ mutationFn: ({ requestId, comment }: { requestId: string; comment: string }) => post<ApprovalRequestDto>(`${requestId}/answer-info`, { comment }), onSuccess: invalidate });
  return { decide, cancel, reassign, requestInfo, answerInfo };
}

/** The one-click e-mail action. The organisation comes from the link (it may not be the active one). */
export function useEmailAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orgId, token, action, comment }: { orgId: string; token: string; action: DecisionKind; comment?: string }) => (await api.post<Envelope<ApprovalDecideResultDto>>(`/orgs/${orgId}/approvals/email-action`, { token, action, comment: comment || undefined })).data,
    onSuccess: (_d, v) => invalidateApprovalViews(qc, v.orgId),
  });
}

// ----- workflows -------------------------------------------------------------------------------------------------------------

export type WorkflowDto = ApprovalWorkflowDto;
export function useWorkflows(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'approval-workflows', {}), queryFn: async () => (await api.get<Envelope<WorkflowDto[]>>(`/orgs/${orgId}/approval-workflows`)).data, enabled });
}
export function useWorkflowMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.entity(orgId, 'approval-workflows') });
  const create = useMutation({ mutationFn: async (input: ApprovalWorkflowInput) => (await api.post<Envelope<WorkflowDto>>(`/orgs/${orgId}/approval-workflows`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<ApprovalWorkflowInput> }) => (await api.patch<Envelope<WorkflowDto>>(`/orgs/${orgId}/approval-workflows/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/approval-workflows/${id}`), onSuccess: invalidate });
  return { create, update, remove };
}

// ----- delegations -----------------------------------------------------------------------------------------------------------

const DELEGATIONS = 'approval-delegations';
export function useDelegations(scope: 'mine' | 'all') {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, DELEGATIONS, { scope }), queryFn: async () => (await api.get<Envelope<ApprovalDelegationDto[]>>(`/orgs/${orgId}/approval-delegations`, { scope })).data });
}
export interface DelegateCandidate { userId: string; fullName: string | null; email: string }
/** Active members a delegation or a reassignment can name (approval.delegate / approval.manage; no user.view needed). */
export function useDelegateCandidates(search: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, DELEGATIONS, { candidates: search }), queryFn: async () => (await api.get<Envelope<DelegateCandidate[]>>(`/orgs/${orgId}/approval-delegations/candidates`, { search: search || undefined })).data, placeholderData: keepPreviousData, enabled });
}
export function useDelegationMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { for (const e of [DELEGATIONS, INBOX]) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const create = useMutation({ mutationFn: async (input: ApprovalDelegationInput) => (await api.post<Envelope<ApprovalDelegationDto>>(`/orgs/${orgId}/approval-delegations`, input)).data, onSuccess: invalidate });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/approval-delegations/${id}`), onSuccess: invalidate });
  return { create, revoke };
}

// ----- access ------------------------------------------------------------------------------------------------------------------

/** Organisation-wide read keys: they open the "All" scope of the inbox. */
export const ORG_WIDE_APPROVAL_KEYS = ['attendance.view', 'leave.view', 'approval.manage'] as const;
export const TEAM_APPROVAL_KEYS = ['attendance.view_team', 'leave.view_team'] as const;

/** Who sees the Approvals inbox: approvers (attendance / leave), approval admins and line managers (a team of their own). */
export function useApprovalAccess() {
  const can = useCan();
  const m = useActiveMembership();
  const any = (keys: readonly string[]) => keys.some((k) => can(k as never));
  const approver = any(['attendance.approve', 'leave.approve', 'approval.manage']);
  const manager = m?.isManager ?? false;
  return {
    inbox: approver || manager,
    orgWide: any(ORG_WIDE_APPROVAL_KEYS),
    team: any(TEAM_APPROVAL_KEYS) || any(ORG_WIDE_APPROVAL_KEYS),
    manage: any(['approval.manage']),
    configure: any(['approval.manage', 'organization.manage']),
    delegate: any(['approval.delegate', 'approval.manage']),
  };
}
