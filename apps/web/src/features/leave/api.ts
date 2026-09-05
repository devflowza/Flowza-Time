import { useMemo } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { LeaveRecordInput, UpdateLeaveRecordInput, leaveTypeInputSchema } from '@flowza/contracts';
import type { ComboboxOption } from '@/components/forms';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import type { LeaveRecordDto, LeaveTypeDto, WithRecalc } from './types';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type LeaveTypeInput = z.infer<typeof leaveTypeInputSchema>;

export function useLeaveTypes() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'leave-types', {}), queryFn: async () => (await api.get<Envelope<LeaveTypeDto[]>>(`/orgs/${orgId}/leave-types`)).data, staleTime: 60_000 });
}
export function useLeaveTypeOptions() {
  const q = useLeaveTypes();
  const options = useMemo<ComboboxOption[]>(() => (q.data ?? []).filter((t) => t.status === 'active').map((t) => ({ value: t.id, label: t.name, description: t.code })), [q.data]);
  const byId = useMemo(() => new Map((q.data ?? []).map((t) => [t.id, t])), [q.data]);
  return { options, byId, isLoading: q.isLoading };
}
export function useLeaveRecords(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'leave-records', query), queryFn: () => api.get<PageEnvelope<LeaveRecordDto>>(`/orgs/${orgId}/leave-records`, query), placeholderData: keepPreviousData });
}

export function useLeaveMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invTypes = () => qc.invalidateQueries({ queryKey: qk.entity(orgId, 'leave-types') });
  const invRecords = () => { for (const e of ['leave-records', 'attendance-daily', 'attendance-monthly']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const createType = useMutation({ mutationFn: async (input: LeaveTypeInput) => (await api.post<Envelope<LeaveTypeDto>>(`/orgs/${orgId}/leave-types`, input)).data, onSuccess: invTypes });
  const updateType = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<LeaveTypeInput> & { status?: string } }) => (await api.patch<Envelope<LeaveTypeDto>>(`/orgs/${orgId}/leave-types/${id}`, input)).data, onSuccess: invTypes });
  const removeType = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/leave-types/${id}`), onSuccess: invTypes });
  const createRecord = useMutation({ mutationFn: async (input: LeaveRecordInput) => (await api.post<Envelope<WithRecalc<LeaveRecordDto>>>(`/orgs/${orgId}/leave-records`, input)).data, onSuccess: invRecords });
  const updateRecord = useMutation({ mutationFn: async ({ id, input }: { id: string; input: UpdateLeaveRecordInput }) => (await api.patch<Envelope<WithRecalc<LeaveRecordDto>>>(`/orgs/${orgId}/leave-records/${id}`, input)).data, onSuccess: invRecords });
  const cancelRecord = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<{ recalculationJobId: string | null }>>(`/orgs/${orgId}/leave-records/${id}`)).data, onSuccess: invRecords });
  return { createType, updateType, removeType, createRecord, updateRecord, cancelRecord };
}
