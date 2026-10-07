import { useMemo } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttendancePointsDetailDto, AttendancePointsRowDto, AttendanceRuleSetInput, CountryRulePack, EmployeeGroupDto, EmployeeGroupInput, EmployeeGroupMemberDto, EmployeeGroupMembersInput, EmployeeGroupMembersResultDto, OvertimeSummaryRowDto, PolicyComplianceDto, PolicyResolutionDto } from '@flowza/contracts';
import type { ComboboxOption } from '@/components/forms';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

/*
 * Global attendance policies (Enterprise, module attendance_policies): employee groups and their members, "which policy
 * applies", the country rule packs and the compliance check, attendance points & discipline, the overtime summary. The
 * policies themselves are the attendance rule sets (features/schedule/api.ts).
 */

export type Query = Record<string, string | number | boolean | undefined>;
const GROUPS = 'employee-groups';
const MEMBERS = 'employee-group-members';

// ---- employee groups ------------------------------------------------------------------------------------------------------
export function useEmployeeGroups(query: Query = {}, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, GROUPS, query), queryFn: async () => (await api.get<Envelope<EmployeeGroupDto[]>>(`/orgs/${orgId}/employee-groups`, query)).data, placeholderData: keepPreviousData, enabled });
}
/** Active groups as Combobox options (a small list). */
export function useEmployeeGroupOptions(enabled = true) {
  const q = useEmployeeGroups({ status: 'active' }, enabled);
  const options = useMemo<ComboboxOption[]>(() => (q.data ?? []).map((g) => ({ value: g.id, label: g.name, description: g.code })), [q.data]);
  const byId = useMemo(() => new Map((q.data ?? []).map((g) => [g.id, g])), [q.data]);
  return { options, byId, isLoading: q.isLoading };
}
export function useEmployeeGroupMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, GROUPS) }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'attendance-rule-sets') }); };
  const create = useMutation({ mutationFn: async (input: EmployeeGroupInput) => (await api.post<Envelope<EmployeeGroupDto>>(`/orgs/${orgId}/employee-groups`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<EmployeeGroupInput> }) => (await api.patch<Envelope<EmployeeGroupDto>>(`/orgs/${orgId}/employee-groups/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: async (id: string) => { await api.delete(`/orgs/${orgId}/employee-groups/${id}`); }, onSuccess: invalidate });
  return { create, update, remove };
}

// ---- members --------------------------------------------------------------------------------------------------------------
export function useGroupMembers(groupId: string | null, query: Query) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, MEMBERS, { groupId, ...query }), queryFn: () => api.get<PageEnvelope<EmployeeGroupMemberDto>>(`/orgs/${orgId}/employee-groups/${groupId}/members`, query), enabled: !!groupId, placeholderData: keepPreviousData });
}
export function useGroupMemberMutations(groupId: string) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, MEMBERS) }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, GROUPS) }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'policy-resolve') }); };
  const add = useMutation({ mutationFn: async (input: EmployeeGroupMembersInput) => (await api.post<Envelope<EmployeeGroupMembersResultDto>>(`/orgs/${orgId}/employee-groups/${groupId}/members`, input)).data, onSuccess: invalidate });
  const end = useMutation({ mutationFn: async ({ id, effectiveTo }: { id: string; effectiveTo: string }) => (await api.patch<Envelope<EmployeeGroupMemberDto & { recalculationJobId: string | null }>>(`/orgs/${orgId}/employee-groups/${groupId}/members/${id}`, { effectiveTo })).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<{ recalculationJobId: string | null }>>(`/orgs/${orgId}/employee-groups/${groupId}/members/${id}`)).data, onSuccess: invalidate });
  return { add, end, remove };
}

// ---- resolution, country packs, compliance ---------------------------------------------------------------------------------
export function usePolicyResolution(params: { employeeId: string | null; date: string }, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'policy-resolve', params), queryFn: async () => (await api.get<Envelope<PolicyResolutionDto>>(`/orgs/${orgId}/attendance-policies/resolve`, { employeeId: params.employeeId ?? undefined, date: params.date })).data, enabled: enabled && !!params.employeeId && !!params.date, retry: false });
}
export function useCountryPacks(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'country-packs'), queryFn: async () => (await api.get<Envelope<CountryRulePack[]>>(`/orgs/${orgId}/attendance-policies/country-packs`)).data, enabled, staleTime: 3_600_000 });
}
/** The compliance warnings of a policy draft against a country pack (a read: POST only because the draft is a body). */
export function usePolicyCompliance(countryCode: string | null, draft: AttendanceRuleSetInput | null) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'policy-compliance', { countryCode, draft }),
    queryFn: async () => (await api.post<Envelope<PolicyComplianceDto>>(`/orgs/${orgId}/attendance-policies/compliance`, draft, { query: { countryCode } })).data,
    enabled: !!countryCode && !!draft, retry: false, staleTime: 60_000, placeholderData: keepPreviousData,
  });
}

// ---- reports ----------------------------------------------------------------------------------------------------------------
export function useAttendancePoints(query: Query) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-points', query), queryFn: () => api.get<PageEnvelope<AttendancePointsRowDto> & { meta: { asOf: string } }>(`/orgs/${orgId}/attendance-policies/points`, query), placeholderData: keepPreviousData });
}
export function useAttendancePointsDetail(employeeId: string | null, asOf: string | undefined) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-points-detail', { employeeId, asOf }), queryFn: async () => (await api.get<Envelope<AttendancePointsDetailDto>>(`/orgs/${orgId}/attendance-policies/points/${employeeId}`, { asOf })).data, enabled: !!employeeId });
}
export function useOvertimeSummary(query: Query, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'overtime-summary', query), queryFn: () => api.get<PageEnvelope<OvertimeSummaryRowDto> & { meta: { month: string } }>(`/orgs/${orgId}/attendance-policies/overtime-summary`, query), placeholderData: keepPreviousData, enabled });
}
