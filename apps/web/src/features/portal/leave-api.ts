import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompOffCreditDto, CompOffPreviewDto, SelfCompOffDto, SelfCompOffRequestInput, SelfLeaveEditInput, SelfLeaveRecordDto, SelfLeaveRequestInput, TeamLeaveDto } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import { SELF } from './api';

/**
 * Leave v2 in the portal (/orgs/:orgId/me/…): apply, edit (re-submitted to the approvers), withdraw with a reason, answer an
 * approver's question, comp-off credits and — for managers — the team's upcoming leave. Every call acts on the caller's own
 * employee record; the API scopes it.
 */
function useInvalidateLeave() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => { for (const e of [SELF, 'leave-records', 'leave-comments', 'leave-balances', 'leave-calendar', 'approvals-inbox', 'approval-request', 'approvals-mine']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
}

export function useSelfLeaveActions() {
  const orgId = useOrgId();
  const invalidate = useInvalidateLeave();
  const apply = useMutation({ mutationFn: async (input: SelfLeaveRequestInput) => (await api.post<Envelope<SelfLeaveRecordDto>>(`/orgs/${orgId}/me/leave`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  const edit = useMutation({ mutationFn: async ({ id, input }: { id: string; input: SelfLeaveEditInput }) => (await api.patch<Envelope<SelfLeaveRecordDto>>(`/orgs/${orgId}/me/leave/${id}`, input)).data, onSuccess: invalidate });
  /** The reason reaches the approvers and the request's timeline (B-98). Approved leave is withdrawn by HR only. */
  const withdraw = useMutation({ mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await api.post<Envelope<SelfLeaveRecordDto>>(`/orgs/${orgId}/me/leave/${id}/withdraw`, { reason })).data, onSuccess: invalidate });
  /** Answer the approver's question: the request goes back to PENDING with the same approvers. */
  const reply = useMutation({ mutationFn: async ({ id, body }: { id: string; body: string }) => (await api.post<Envelope<SelfLeaveRecordDto>>(`/orgs/${orgId}/me/leave/${id}/reply`, { body })).data, onSuccess: invalidate });
  return { apply, edit, withdraw, reply };
}

export function useSelfCompOff() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SELF, { view: 'comp-off' }), queryFn: async () => (await api.get<Envelope<SelfCompOffDto>>(`/orgs/${orgId}/me/comp-off`)).data, staleTime: 30_000 });
}
/** What a worked date would earn (its day type from the calendar, the minutes the daily record holds). */
export function useCompOffPreview(workedOn: string | null) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SELF, { view: 'comp-off-preview', workedOn }), queryFn: async () => (await api.get<Envelope<CompOffPreviewDto>>(`/orgs/${orgId}/me/comp-off/preview`, { workedOn: workedOn! })).data, enabled: !!workedOn && /^\d{4}-\d{2}-\d{2}$/.test(workedOn), staleTime: 30_000 });
}
export function useRequestCompOff() {
  const orgId = useOrgId();
  const invalidate = useInvalidateLeave();
  return useMutation({ mutationFn: async (input: SelfCompOffRequestInput) => (await api.post<Envelope<CompOffCreditDto>>(`/orgs/${orgId}/me/comp-off`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
}

/** A manager's team: approved or pending leave ending today or later (at most 20). */
export function useTeamLeave(enabled: boolean) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SELF, { view: 'team-leave' }), queryFn: async () => (await api.get<Envelope<TeamLeaveDto[]>>(`/orgs/${orgId}/me/team/leave`)).data, enabled, staleTime: 60_000 });
}
