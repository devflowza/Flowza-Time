import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HourAllowanceDto, HourAllowanceInput, HourAllowanceUpdateInput, SelfTimeOffDto, SelfTimeOffRequestInput, TimeOffRequestDto, TimeOffRequestInput, TimeOffTypeDto, TimeOffTypeInput, TimeOffTypeUpdateInput, WithTimeOffRecalc } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export interface WarningDto { code: string; message: string; params?: Record<string, unknown> }

const TYPES = 'time-off-types';
const REQUESTS = 'time-off-requests';
const SELF = 'self-time-off';
const ALLOWANCES = 'hour-allowances';
/** Everything a short leave decision can move: the lists, the portal, the approval views and the attendance it feeds. */
const REQUEST_VIEWS = [REQUESTS, SELF, 'approvals-inbox', 'approval-request', 'approvals-mine', 'attendance-daily', 'attendance-monthly', 'self-service'];

function useInvalidate(entities: readonly string[]) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => { for (const e of entities) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
}

// ----- types (HR) -----------------------------------------------------------------------------------------------------------

export function useTimeOffTypes(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, TYPES, {}), queryFn: async () => (await api.get<Envelope<TimeOffTypeDto[]>>(`/orgs/${orgId}/time-off-types`)).data, staleTime: 60_000, enabled });
}
export function useTimeOffTypeMutations() {
  const orgId = useOrgId();
  const inv = useInvalidate([TYPES, SELF]);
  const create = useMutation({ mutationFn: async (input: TimeOffTypeInput) => (await api.post<Envelope<TimeOffTypeDto>>(`/orgs/${orgId}/time-off-types`, input)).data, onSuccess: inv });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: TimeOffTypeUpdateInput }) => (await api.patch<Envelope<TimeOffTypeDto>>(`/orgs/${orgId}/time-off-types/${id}`, input)).data, onSuccess: inv });
  const remove = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<{ archived: boolean }>>(`/orgs/${orgId}/time-off-types/${id}`)).data, onSuccess: inv });
  const seed = useMutation({ mutationFn: async () => (await api.post<Envelope<{ created: string[]; types: TimeOffTypeDto[] }>>(`/orgs/${orgId}/time-off-types/seed-defaults`)).data, onSuccess: inv });
  return { create, update, remove, seed };
}

// ----- requests (HR) -----------------------------------------------------------------------------------------------------------

export function useTimeOffRequests(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, REQUESTS, query), queryFn: () => api.get<PageEnvelope<TimeOffRequestDto>>(`/orgs/${orgId}/time-off-requests`, query), placeholderData: keepPreviousData });
}
export function useTimeOffRequestMutations() {
  const orgId = useOrgId();
  const inv = useInvalidate(REQUEST_VIEWS);
  /** HR records a short leave for an employee: approved at once (unless a workflow applies); limits come back as warnings. */
  const record = useMutation({ mutationFn: async (input: TimeOffRequestInput) => (await api.post<Envelope<WithTimeOffRecalc<TimeOffRequestDto> & { warnings: WarningDto[] }>>(`/orgs/${orgId}/time-off-requests`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: inv });
  const cancel = useMutation({ mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await api.post<Envelope<WithTimeOffRecalc<TimeOffRequestDto>>>(`/orgs/${orgId}/time-off-requests/${id}/cancel`, { reason })).data, onSuccess: inv });
  return { record, cancel };
}

// ----- the employee (portal) -----------------------------------------------------------------------------------------------------

export function useSelfTimeOff(month: string) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SELF, { month }), queryFn: async () => (await api.get<Envelope<SelfTimeOffDto>>(`/orgs/${orgId}/me/time-off`, { month })).data, staleTime: 30_000 });
}
export function useSelfTimeOffActions() {
  const orgId = useOrgId();
  const inv = useInvalidate(REQUEST_VIEWS);
  const request = useMutation({ mutationFn: async (input: SelfTimeOffRequestInput) => (await api.post<Envelope<WithTimeOffRecalc<TimeOffRequestDto>>>(`/orgs/${orgId}/me/time-off`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: inv });
  /** Pending only; the reason reaches the approvers. Approved short leave is cancelled by HR. */
  const withdraw = useMutation({ mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await api.post<Envelope<TimeOffRequestDto>>(`/orgs/${orgId}/me/time-off/${id}/withdraw`, { reason })).data, onSuccess: inv });
  return { request, withdraw };
}

// ----- reduced hours (employee profile) ------------------------------------------------------------------------------------------

export function useHourAllowances(employeeId: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, ALLOWANCES, { employeeId }), queryFn: async () => (await api.get<Envelope<HourAllowanceDto[]>>(`/orgs/${orgId}/employees/${employeeId}/hour-allowances`)).data, enabled: enabled && !!employeeId });
}
export function useHourAllowanceMutations(employeeId: string) {
  const orgId = useOrgId();
  const inv = useInvalidate([ALLOWANCES, SELF, 'attendance-daily', 'attendance-monthly']);
  const create = useMutation({ mutationFn: async (input: HourAllowanceInput) => (await api.post<Envelope<WithTimeOffRecalc<HourAllowanceDto>>>(`/orgs/${orgId}/employees/${employeeId}/hour-allowances`, input)).data, onSuccess: inv });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: HourAllowanceUpdateInput }) => (await api.patch<Envelope<WithTimeOffRecalc<HourAllowanceDto>>>(`/orgs/${orgId}/hour-allowances/${id}`, input)).data, onSuccess: inv });
  const remove = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<{ recalculationJobId: string | null }>>(`/orgs/${orgId}/hour-allowances/${id}`)).data, onSuccess: inv });
  return { create, update, remove };
}
