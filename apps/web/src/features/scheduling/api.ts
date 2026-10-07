import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdditionalShiftAssignmentDto, AdditionalShiftAssignmentInput, BranchDeploymentDto, BranchDeploymentInput, RoundTheClockInput, RoundTheClockPlanDto, RoundTheClockResultDto,
  ShiftCoverageDto, ShiftCoverageInput, ShiftCoverageReportDto,
} from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

/*
 * Round-the-clock scheduling (Enterprise, module advanced_scheduling) — TanStack Query hooks over
 * /orgs/:orgId/{round-the-clock, shift-coverage, additional-shift-assignments, branch-deployments}.
 *
 * Job ids are NOT interchangeable (AGENTS.md): `enrolJobId` / `cleanupJobId` of a deployment are sync_jobs ids (/sync/:id renders
 * them); `recalculationJobId` is a queue job id (the attendance recalculation tab tracks it).
 */

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type WithRecalc<T> = T & { recalculationJobId: string | null };
type RtcPreviewInput = Pick<RoundTheClockInput, 'template' | 'codePrefix' | 'namePrefix' | 'firstShiftStart' | 'anchorDate' | 'breakMinutes'>;

// ---- round-the-clock --------------------------------------------------------------------------------------------------
/** The plan of a template (nothing is created); `input` null = not ready to ask. */
export function useRoundTheClockPreview(input: RtcPreviewInput | null) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'round-the-clock-preview', input ?? {}),
    queryFn: async () => (await api.post<Envelope<RoundTheClockPlanDto>>(`/orgs/${orgId}/round-the-clock/preview`, input)).data,
    enabled: !!input, placeholderData: keepPreviousData, retry: false,
  });
}
export function useApplyRoundTheClock() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RoundTheClockInput) => (await api.post<Envelope<RoundTheClockResultDto>>(`/orgs/${orgId}/round-the-clock`, input)).data,
    onSuccess: () => { for (const e of ['shifts', 'shift-patterns', 'shift-assignments', 'shift-coverage', 'shift-coverage-report', 'shift-resolve']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); },
  });
}

// ---- coverage ---------------------------------------------------------------------------------------------------------
export function useCoverage(query: ListQuery = {}) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'shift-coverage', query), queryFn: async () => (await api.get<Envelope<ShiftCoverageDto[]>>(`/orgs/${orgId}/shift-coverage`, query)).data, placeholderData: keepPreviousData });
}
export function useCoverageReport(params: { branchId: string | null; from: string; to: string }) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'shift-coverage-report', params),
    queryFn: async () => (await api.get<Envelope<ShiftCoverageReportDto>>(`/orgs/${orgId}/shift-coverage/report`, { branchId: params.branchId ?? undefined, from: params.from, to: params.to })).data,
    enabled: !!params.branchId && !!params.from && !!params.to && params.to >= params.from, placeholderData: keepPreviousData, retry: false,
  });
}
export function useCoverageMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'shift-coverage') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'shift-coverage-report') }); };
  const create = useMutation({ mutationFn: async (input: ShiftCoverageInput) => (await api.post<Envelope<ShiftCoverageDto>>(`/orgs/${orgId}/shift-coverage`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: { weekdays?: number[]; minHeadcount?: number } }) => (await api.patch<Envelope<ShiftCoverageDto>>(`/orgs/${orgId}/shift-coverage/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/shift-coverage/${id}`), onSuccess: invalidate });
  return { create, update, remove };
}

// ---- additional (double) shifts ---------------------------------------------------------------------------------------
export function useAdditionalShifts(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'additional-shift-assignments', query), queryFn: () => api.get<PageEnvelope<AdditionalShiftAssignmentDto>>(`/orgs/${orgId}/additional-shift-assignments`, query), placeholderData: keepPreviousData });
}
export function useAdditionalShiftMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { for (const e of ['additional-shift-assignments', 'shift-coverage-report']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const create = useMutation({ mutationFn: async (input: AdditionalShiftAssignmentInput) => (await api.post<Envelope<WithRecalc<AdditionalShiftAssignmentDto>>>(`/orgs/${orgId}/additional-shift-assignments`, input)).data, onSuccess: invalidate });
  const end = useMutation({ mutationFn: async ({ id, effectiveTo }: { id: string; effectiveTo: string | null }) => (await api.patch<Envelope<WithRecalc<AdditionalShiftAssignmentDto>>>(`/orgs/${orgId}/additional-shift-assignments/${id}`, { effectiveTo })).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<{ recalculationJobId: string | null }>>(`/orgs/${orgId}/additional-shift-assignments/${id}`)).data, onSuccess: invalidate });
  return { create, end, remove };
}

// ---- branch deployments -----------------------------------------------------------------------------------------------
export function useDeployments(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'branch-deployments', query), queryFn: () => api.get<PageEnvelope<BranchDeploymentDto>>(`/orgs/${orgId}/branch-deployments`, query), placeholderData: keepPreviousData });
}
export function useDeploymentMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'branch-deployments') }); };
  const create = useMutation({ mutationFn: async (input: BranchDeploymentInput) => (await api.post<Envelope<BranchDeploymentDto>>(`/orgs/${orgId}/branch-deployments`, input)).data, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await api.post<Envelope<BranchDeploymentDto>>(`/orgs/${orgId}/branch-deployments/${id}/cancel`, { reason })).data, onSuccess: invalidate });
  return { create, cancel };
}
