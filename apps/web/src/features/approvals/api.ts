import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalBulkDecideResultDto, ApprovalDecideResultDto, ApprovalDelegationDto, ApprovalEmailPreviewDto, ApprovalDelegationInput, ApprovalEntity, ApprovalInboxScope, ApprovalRequestDto, ApprovalWorkflowDto, ApprovalWorkflowInput } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { env } from '@/lib/env';
import { qk } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';
import { meQueryKey, useActiveMembership, useCan, useOrgId } from '@/features/me/use-me';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type { ApprovalRequestDto, ApprovalWorkflowDto, ApprovalDelegationDto };
export type InboxView = 'pending' | 'history';
export type DecisionKind = 'APPROVE' | 'REJECT';

/** Query-key entities of the approvals feature; every mutation invalidates all of them plus the documents behind them. */
const INBOX = 'approvals-inbox';
const REQUEST = 'approval-request';
const MINE = 'approvals-mine';
const DOCUMENTS = ['attendance-corrections', 'attendance-records', 'attendance-daily', 'attendance-monthly', 'leave-records', 'self-service', 'attendance-notes', 'selfie-checkins', 'leave-comments', 'leave-balances', 'leave-calendar',
  // HR portal Prompt 5 / 6b: the team workspace (board, counts behind the manager badge) and the HR regularisation register
  'team-summary', 'team-attendance', 'team-leave', 'team-pending-counts', 'attendance-regularisations', 'attendance-notes-report'];
/**
 * Everything a decision can move: the approval views, the documents behind them, the dashboard (its pending count) and
 * /me (`approvals.actionable`, which opens the Approvals navigation for members without an approve key).
 */
export function invalidateApprovalViews(qc: ReturnType<typeof useQueryClient>, orgId: string) {
  for (const e of [INBOX, REQUEST, MINE, ...DOCUMENTS]) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) });
  void qc.invalidateQueries({ queryKey: ['dashboard', orgId] });
  void qc.invalidateQueries({ queryKey: meQueryKey });
}

export interface InboxQuery { scope: ApprovalInboxScope; view: InboxView; entityType?: ApprovalEntity | undefined; search?: string | undefined; page: number; pageSize: number }

export function useApprovalInbox(query: InboxQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, INBOX, query), queryFn: () => api.get<PageEnvelope<ApprovalRequestDto>>(`/orgs/${orgId}/approvals`, { ...query, entityType: query.entityType || undefined, search: query.search || undefined }), placeholderData: keepPreviousData, refetchInterval: 60_000, enabled });
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
  /**
   * Decides the level the caller saw (`stepNo` is required: a level that moved on meanwhile is refused, never re-targeted).
   * payEffectDays: an ATTENDANCE_NOTE rejection's pay effect (0 / 0.5 / 1 day); ignored by every other entity.
   */
  const decide = useMutation({ mutationFn: ({ requestId, stepNo, decision, comment, onBehalfOfUserId, payEffectDays }: { requestId: string; stepNo: number; decision: DecisionKind; comment?: string; onBehalfOfUserId?: string; payEffectDays?: 0 | 0.5 | 1 }) => post<ApprovalDecideResultDto>(`${requestId}/decide`, { stepNo, decision, comment: comment || undefined, onBehalfOfUserId, payEffectDays }), onSuccess: invalidate });
  /** Withdrawing a request always says why (at least 3 characters, Finance B-98). */
  const cancel = useMutation({ mutationFn: ({ requestId, reason }: { requestId: string; reason: string }) => post<ApprovalRequestDto>(`${requestId}/cancel`, { reason }), onSuccess: invalidate });
  const reassign = useMutation({ mutationFn: ({ requestId, userId, reason, stepNo }: { requestId: string; userId: string; reason: string; stepNo?: number }) => post<ApprovalRequestDto>(`${requestId}/reassign`, { userId, reason, stepNo }), onSuccess: invalidate });
  const requestInfo = useMutation({ mutationFn: ({ requestId, comment }: { requestId: string; comment: string }) => post<ApprovalRequestDto>(`${requestId}/request-info`, { comment }), onSuccess: invalidate });
  const answerInfo = useMutation({ mutationFn: ({ requestId, comment }: { requestId: string; comment: string }) => post<ApprovalRequestDto>(`${requestId}/answer-info`, { comment }), onSuccess: invalidate });
  /** approval.manage: approve as an exception (every open level skipped), the reason is mandatory. */
  const bypass = useMutation({ mutationFn: ({ requestId, reason }: { requestId: string; reason: string }) => post<ApprovalRequestDto>(`${requestId}/bypass`, { reason }), onSuccess: invalidate });
  /**
   * The same decision on several requests; the API decides each one through the engine and reports one line per request.
   * Each line names the level the caller saw on that row, so a late click never closes the next level; a line may name the
   * seat an override fills (`onBehalfOfUserId`) — a line that needs one and lacks it is refused on its own.
   */
  const bulkDecide = useMutation({ mutationFn: async ({ items, decision, comment }: { items: Array<{ requestId: string; stepNo: number; onBehalfOfUserId?: string }>; decision: DecisionKind; comment?: string }) => (await api.post<Envelope<ApprovalBulkDecideResultDto>>(`/orgs/${orgId}/approvals/bulk-decide`, { items, decision, comment: comment || undefined })).data, onSuccess: invalidate });
  return { decide, cancel, reassign, bypass, requestInfo, answerInfo, bulkDecide };
}

/**
 * The History view as CSV (report.export; the API audits every export). Served as text/csv behind auth, so it is fetched
 * with the bearer token and saved as a Blob — the same way as the employee import template.
 */
export async function downloadApprovalHistory(orgId: string, query: Omit<InboxQuery, 'view' | 'page' | 'pageSize'>): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const params = new URLSearchParams({ scope: query.scope, ...(query.entityType ? { entityType: query.entityType } : {}), ...(query.search ? { search: query.search } : {}) });
  const res = await fetch(`${env.apiUrl}/api/v1/orgs/${orgId}/approvals/history/export?${params.toString()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'approvals-history.csv';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * What a one-click e-mail link is about, BEFORE the approver confirms (notifications review 8-P0-1): the API reads the request
 * itself — never the e-mail — and spends nothing. Not retried: a used, expired or foreign link answers the same every time.
 */
export function useEmailPreview({ orgId, token, action }: { orgId: string; token: string; action: DecisionKind | null }) {
  return useQuery({
    queryKey: ['approval-email-preview', orgId, token, action],
    queryFn: async () => (await api.post<Envelope<ApprovalEmailPreviewDto>>(`/orgs/${orgId}/approvals/email-action/preview`, { token, action })).data,
    enabled: !!orgId && !!token && !!action,
    retry: false,
    staleTime: Infinity,
  });
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

/**
 * What the approvals screens offer the caller. The inbox itself is open to every active member (the API scopes its rows):
 * a delegate, a named USER approver or an escalated approver may hold no approve key at all (review P1-6). `nav` decides
 * whether the Approvals item is worth showing: an approve key or approval.manage, direct reports, or /me reporting
 * approvals waiting for them / a delegation to them in force today.
 */
export function useApprovalAccess() {
  const can = useCan();
  const m = useActiveMembership();
  const any = (keys: readonly string[]) => keys.some((k) => can(k as never));
  const approver = any(['attendance.approve', 'leave.approve', 'approval.manage']);
  const manager = m?.isManager ?? false;
  // a /me cached before the field existed has no `approvals`: treat it as nothing waiting
  const signal = m?.approvals as { actionable?: number; delegatedToMe?: boolean } | undefined;
  const waitingForMe = (signal?.actionable ?? 0) > 0 || signal?.delegatedToMe === true;
  return {
    inbox: !!m,
    nav: approver || manager || waitingForMe,
    waitingForMe,
    orgWide: any(ORG_WIDE_APPROVAL_KEYS),
    team: any(TEAM_APPROVAL_KEYS) || any(ORG_WIDE_APPROVAL_KEYS),
    manage: any(['approval.manage']),
    configure: any(['approval.manage', 'organization.manage']),
    delegate: any(['approval.delegate', 'approval.manage']),
  };
}
