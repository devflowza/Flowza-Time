import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalRequestDto, ApprovalWorkflowInput } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import type { CorrectionDto } from '@/features/attendance/types';

export type ListQuery = Record<string, string | number | boolean | undefined>;

export interface InboxItem {
  stepId: string; stepNo: number; approverType: string; requestId: string; entityType: string; entityId: string; branchId: string | null; employeeId: string | null; currentStep: number;
  requestedBy: string | null; requestedByName: string | null; createdAt: string; correction: CorrectionDto | null;
}
export interface WorkflowStep { order: number; approverType: 'MANAGER' | 'ROLE' | 'USER'; roleId?: string; userId?: string }
export interface WorkflowDto { id: string; organizationId: string; entityType: string; name: string; branchId: string | null; steps: WorkflowStep[]; isDefault: boolean; status: string; createdAt: string; updatedAt: string }
export type DecisionResult = ApprovalRequestDto & { correction: CorrectionDto | null };

export function useApprovalInbox(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'approvals-inbox', query), queryFn: () => api.get<PageEnvelope<InboxItem>>(`/orgs/${orgId}/approvals/inbox`, query), placeholderData: keepPreviousData, refetchInterval: 60_000 });
}
export function useApprovalMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { for (const e of ['approvals-inbox', 'attendance-corrections', 'attendance-records', 'attendance-daily', 'attendance-monthly']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const decide = useMutation({ mutationFn: async ({ requestId, decision, comment }: { requestId: string; decision: 'approve' | 'reject'; comment?: string }) => (await api.post<Envelope<DecisionResult>>(`/orgs/${orgId}/approvals/${requestId}/${decision}`, { comment: comment || undefined })).data, onSuccess: invalidate });
  return { decide };
}

export function useWorkflows() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'approval-workflows', {}), queryFn: async () => (await api.get<Envelope<WorkflowDto[]>>(`/orgs/${orgId}/approval-workflows`)).data });
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
