import { useMemo } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaimPendingDeviceInput, CreateDeviceInput, DeviceCommandDto, DeviceCredentialsInput, DeviceDto, DeviceEmployeeSyncStatus, DeviceGroupDto, DeviceGroupInput, DeviceLogDto, DeviceModelDto, DeviceProviderDto, DevicePushCredentials, DeviceSummaryDto, EmploymentStatus, PendingDeviceDto, ProviderThrottling, SyncJobAcceptedDto, TestConnectionInput, TestConnectionResultDto, UpdateDeviceInput } from '@flowza/contracts';
import type { ComboboxOption } from '@/components/forms';
import { api, apiFetch, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

export type ListQuery = Record<string, string | number | boolean | undefined>;
/** GET /device-providers adds registry details to the contract DTO. */
export type ProviderDto = DeviceProviderDto & { secretFields: string[]; throttling: ProviderThrottling; supportsWebhook: boolean; pushProtocolKey: string | null };
export type DeviceDetail = DeviceDto & { hasPushToken: boolean; generation: number; notes: string | null; consecutiveFailures: number; pushProtocolKey: string | null; groupIds: string[] };
export type DeviceRow = DeviceDto & { hasPushToken?: boolean; consecutiveFailures?: number };
export interface DeviceCreatedDto { device: DeviceDto; pushToken: string | null; pushUrl: string | null; webhookUrl: string | null; credentialsStored: boolean; credentialsError: string | null; testConnectionJobId: string | null }
export interface DeviceEmployeeStateDto {
  id: string; deviceId: string; employeeId: string | null; employeeNumber: string | null; employeeName: string | null; employmentStatus: EmploymentStatus | null; deviceUserId: string; syncStatus: DeviceEmployeeSyncStatus; desired: boolean;
  inSync: boolean; deviceOnly: boolean; lastSyncAt: string | null; lastSuccessAt: string | null; lastErrorCode: string | null; lastError: string | null; fingerprintCount: number; faceEnrolled: boolean; cardEnrolled: boolean; deviceRecord: Record<string, unknown> | null; updatedAt: string;
}
export type DeviceAction = 'sync-attendance' | 'sync-employees' | 'health-check' | 'reconcile' | 'restart';
/** 202 body of POST /devices/:id/actions/:action — same shape as the sync endpoints (status SUCCESS when every item was already in flight). */
export type DeviceActionAccepted = SyncJobAcceptedDto;

const ENTITY = 'devices';
const GROUPS = 'device-groups';

// ---- reference data -----------------------------------------------------------------------------------------------------

export function useProviders() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['device-providers', orgId], queryFn: async () => (await api.get<Envelope<ProviderDto[]>>('/device-providers', { orgId })).data, staleTime: 5 * 60_000 });
}
export function useDeviceModels(providerKey: string | undefined) {
  return useQuery({ queryKey: ['device-models', providerKey ?? ''], queryFn: async () => (await api.get<Envelope<DeviceModelDto[]>>('/device-models', { providerKey })).data, enabled: !!providerKey, staleTime: 5 * 60_000 });
}

// ---- devices ------------------------------------------------------------------------------------------------------------

export function useDevices(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, ENTITY, query), queryFn: () => api.get<PageEnvelope<DeviceRow>>(`/orgs/${orgId}/devices`, query), placeholderData: keepPreviousData, enabled, refetchInterval: 30_000 });
}
/** Fleet counts from GET /devices/summary (server-side, branch-scoped) — never aggregate a page of the list client-side. */
export function useDeviceSummary(query: { branchId?: string; includeDecommissioned?: boolean } = {}) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.entity(orgId, ENTITY), 'summary', query], queryFn: async () => (await api.get<Envelope<DeviceSummaryDto>>(`/orgs/${orgId}/devices/summary`, query)).data, placeholderData: keepPreviousData, refetchInterval: 30_000 });
}
export function useDevice(id: string | undefined) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, ENTITY, id ?? ''), queryFn: async () => (await api.get<Envelope<DeviceDetail>>(`/orgs/${orgId}/devices/${id}`)).data, enabled: !!id, refetchInterval: 30_000 });
}
/** Small option list for pickers (devices are few per organisation). */
export function useDeviceOptions(branchId?: string | null) {
  const q = useDevices({ pageSize: 200, sort: 'name', branchId: branchId ?? undefined });
  const options = useMemo<ComboboxOption[]>(() => (q.data?.data ?? []).map((d) => ({ value: d.id, label: d.name, description: d.code })), [q.data]);
  return { options, isLoading: q.isLoading, data: q.data?.data ?? [] };
}
export function useDeviceLogs(id: string, query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.detail(orgId, ENTITY, id), 'logs', query], queryFn: () => api.get<PageEnvelope<DeviceLogDto>>(`/orgs/${orgId}/devices/${id}/logs`, query), placeholderData: keepPreviousData, refetchInterval: 30_000 });
}
export function useDeviceEmployees(id: string, query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.detail(orgId, ENTITY, id), 'employees', query], queryFn: () => api.get<PageEnvelope<DeviceEmployeeStateDto>>(`/orgs/${orgId}/devices/${id}/employees`, query), placeholderData: keepPreviousData, refetchInterval: 30_000 });
}
export function useDeviceCommands(id: string, query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.detail(orgId, ENTITY, id), 'commands', query], queryFn: () => api.get<PageEnvelope<DeviceCommandDto>>(`/orgs/${orgId}/devices/${id}/commands`, query), placeholderData: keepPreviousData, refetchInterval: 15_000 });
}

export function useDeviceMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidateAll = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, ENTITY) }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'sync-jobs') }); };
  const invalidateOne = (id: string) => qc.invalidateQueries({ queryKey: qk.detail(orgId, ENTITY, id) });
  const idem = () => ({ idempotencyKey: crypto.randomUUID() });
  const create = useMutation({ mutationFn: async (input: CreateDeviceInput) => (await api.post<Envelope<DeviceCreatedDto>>(`/orgs/${orgId}/devices`, input, idem())).data, onSuccess: invalidateAll });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: UpdateDeviceInput }) => (await api.patch<Envelope<DeviceDto & { credentialsRequired: boolean }>>(`/orgs/${orgId}/devices/${id}`, input)).data, onSuccess: invalidateAll });
  const remove = useMutation({ mutationFn: async ({ id, decommission }: { id: string; decommission: boolean }) => (await apiFetch<Envelope<DeviceDto>>(`/orgs/${orgId}/devices/${id}`, { method: 'DELETE', query: { decommission } })).data, onSuccess: invalidateAll });
  const putCredentials = useMutation({ mutationFn: async ({ id, input }: { id: string; input: DeviceCredentialsInput }) => (await api.post<Envelope<{ version: number; masked: Record<string, unknown> }>>(`/orgs/${orgId}/devices/${id}/credentials`, input)).data, onSuccess: (_d, v) => void invalidateOne(v.id) });
  const rotatePushToken = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<DevicePushCredentials>>(`/orgs/${orgId}/devices/${id}/push-token/rotate`)).data, onSuccess: (_d, id) => void invalidateOne(id) });
  const testConnection = useMutation({ mutationFn: async (input: TestConnectionInput) => (await api.post<Envelope<TestConnectionResultDto>>(`/orgs/${orgId}/devices/test-connection`, input)).data });
  const runAction = useMutation({ mutationFn: async ({ id, action }: { id: string; action: DeviceAction }) => (await api.post<Envelope<DeviceActionAccepted>>(`/orgs/${orgId}/devices/${id}/actions/${action}`, undefined, idem())).data, onSuccess: invalidateAll });
  const claim = useMutation({ mutationFn: async ({ id, input }: { id: string; input: ClaimPendingDeviceInput }) => (await api.post<Envelope<DeviceCreatedDto>>(`/orgs/${orgId}/devices/pending/${id}/claim`, input, idem())).data, onSuccess: () => { invalidateAll(); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'pending-devices') }); } });
  return { create, update, remove, putCredentials, rotatePushToken, testConnection, runAction, claim };
}

// ---- pending & groups -------------------------------------------------------------------------------------------------------

export function usePendingDevices(serialNumber?: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'pending-devices', { serialNumber }), queryFn: async () => (await api.get<Envelope<PendingDeviceDto[]>>(`/orgs/${orgId}/devices/pending`, { serialNumber: serialNumber || undefined })).data, enabled, refetchInterval: 20_000, retry: false });
}
export function useDeviceGroups() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, GROUPS, {}), queryFn: async () => (await api.get<Envelope<DeviceGroupDto[]>>(`/orgs/${orgId}/device-groups`)).data });
}
export function useDeviceGroup(id: string | null) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, GROUPS, id ?? ''), queryFn: async () => (await api.get<Envelope<DeviceGroupDto>>(`/orgs/${orgId}/device-groups/${id}`)).data, enabled: !!id });
}
export function useGroupOptions() {
  const q = useDeviceGroups();
  const options = useMemo<ComboboxOption[]>(() => (q.data ?? []).map((g) => ({ value: g.id, label: g.name, description: g.branchName ?? undefined })), [q.data]);
  return { options, isLoading: q.isLoading, data: q.data ?? [] };
}
export function useGroupMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, GROUPS) }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, ENTITY) }); };
  const create = useMutation({ mutationFn: async (input: DeviceGroupInput) => (await api.post<Envelope<DeviceGroupDto>>(`/orgs/${orgId}/device-groups`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<DeviceGroupInput> }) => (await api.patch<Envelope<DeviceGroupDto>>(`/orgs/${orgId}/device-groups/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/device-groups/${id}`), onSuccess: invalidate });
  const addMembers = useMutation({ mutationFn: async ({ id, deviceIds }: { id: string; deviceIds: string[] }) => (await api.post<Envelope<DeviceGroupDto>>(`/orgs/${orgId}/device-groups/${id}/members`, { deviceIds })).data, onSuccess: invalidate });
  const removeMembers = useMutation({ mutationFn: async ({ id, deviceIds }: { id: string; deviceIds: string[] }) => (await apiFetch<Envelope<DeviceGroupDto>>(`/orgs/${orgId}/device-groups/${id}/members`, { method: 'DELETE', body: { deviceIds } })).data, onSuccess: invalidate });
  return { create, update, remove, addMembers, removeMembers };
}
