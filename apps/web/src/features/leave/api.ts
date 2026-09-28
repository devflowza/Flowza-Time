import { useMemo } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { LeaveAllocationGenerateResultDto, LeaveAllocationRowInput, LeaveAllocationUpsertResultDto, LeaveRecordInput, LeaveYearCloseQueuedDto, UpdateLeaveRecordInput, leaveTypeInputSchema } from '@flowza/contracts';
import type { ComboboxOption } from '@/components/forms';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { env } from '@/lib/env';
import { qk } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';
import { useOrgId } from '@/features/me/use-me';
import type { EmployeeLeaveBalancesDto, LeaveAllocationDto, LeaveCalendarDto, LeaveCommentDto, LeaveRecordDto, LeaveTypeDto, WithRecalc } from './types';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type LeaveTypeInput = z.infer<typeof leaveTypeInputSchema>;

/** Everything a leave change can move: the lists, the attendance it feeds, the approval views, the portal and balances. */
const LEAVE_VIEWS = ['leave-records', 'leave-balances', 'leave-allocations', 'leave-calendar', 'leave-comments', 'attendance-daily', 'attendance-monthly', 'approvals-inbox', 'approval-request', 'approvals-mine', 'self-service'];

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
  const invTypes = () => { for (const e of ['leave-types', 'leave-balances', 'self-service']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  // A leave record travels through the approval engine: its request (inbox, drawer, portal status) and the balances move with it.
  const invRecords = () => { for (const e of LEAVE_VIEWS) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const createType = useMutation({ mutationFn: async (input: LeaveTypeInput) => (await api.post<Envelope<LeaveTypeDto>>(`/orgs/${orgId}/leave-types`, input)).data, onSuccess: invTypes });
  const updateType = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<LeaveTypeInput> & { status?: string } }) => (await api.patch<Envelope<LeaveTypeDto>>(`/orgs/${orgId}/leave-types/${id}`, input)).data, onSuccess: invTypes });
  const removeType = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/leave-types/${id}`), onSuccess: invTypes });
  const seedDefaults = useMutation({ mutationFn: async () => (await api.post<Envelope<{ created: string[]; leaveTypes: LeaveTypeDto[] }>>(`/orgs/${orgId}/leave-types/seed-defaults`)).data, onSuccess: invTypes });
  const createRecord = useMutation({ mutationFn: async (input: LeaveRecordInput) => (await api.post<Envelope<WithRecalc<LeaveRecordDto>>>(`/orgs/${orgId}/leave-records`, input)).data, onSuccess: invRecords });
  /** A decision sends the approval level the user saw (`stepNo`): the API refuses it when the request has moved on (P1-2). */
  const updateRecord = useMutation({ mutationFn: async ({ id, input }: { id: string; input: UpdateLeaveRecordInput }) => (await api.patch<Envelope<WithRecalc<LeaveRecordDto>>>(`/orgs/${orgId}/leave-records/${id}`, input)).data, onSuccess: invRecords });
  const cancelRecord = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<{ recalculationJobId: string | null }>>(`/orgs/${orgId}/leave-records/${id}`)).data, onSuccess: invRecords });
  return { createType, updateType, removeType, seedDefaults, createRecord, updateRecord, cancelRecord };
}

// ----- leave v2: balances, allocations, year close, calendar -------------------------------------------------------------

export function useLeaveBalances(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'leave-balances', query), queryFn: () => api.get<PageEnvelope<EmployeeLeaveBalancesDto>>(`/orgs/${orgId}/leave-balances`, query), placeholderData: keepPreviousData });
}
export function useLeaveAllocations(query: ListQuery & { year: number }) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'leave-allocations', query), queryFn: () => api.get<PageEnvelope<LeaveAllocationDto>>(`/orgs/${orgId}/leave-allocations`, query), placeholderData: keepPreviousData });
}
export function useLeaveCalendar(query: { month: string; branchId?: string; departmentId?: string; includePending?: boolean }) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'leave-calendar', query), queryFn: async () => (await api.get<Envelope<LeaveCalendarDto>>(`/orgs/${orgId}/leave-calendar`, query)).data, placeholderData: keepPreviousData });
}

export function useLeaveAllocationMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const inv = () => { for (const e of ['leave-allocations', 'leave-balances', 'self-service']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const save = useMutation({ mutationFn: async (rows: LeaveAllocationRowInput[]) => (await api.put<Envelope<LeaveAllocationUpsertResultDto>>(`/orgs/${orgId}/leave-allocations`, { rows })).data, onSuccess: inv });
  const generate = useMutation({ mutationFn: async (input: { year: number; leaveTypeIds?: string[] }) => (await api.post<Envelope<LeaveAllocationGenerateResultDto>>(`/orgs/${orgId}/leave-allocations/generate`, input)).data, onSuccess: inv });
  /** Queued (202): the worker carries the unused days forward; the job id is returned for the job viewer. */
  const closeYear = useMutation({ mutationFn: async (fromYear: number) => (await api.post<Envelope<LeaveYearCloseQueuedDto>>(`/orgs/${orgId}/leave-allocations/year-close`, { fromYear })).data, onSuccess: inv });
  return { save, generate, closeYear };
}

/** GET …/leave-balances/export — the CSV (report.export) downloaded with the caller's session, as the other exports do. */
export async function downloadLeaveBalances(orgId: string, query: { year?: number; branchId?: string; departmentId?: string; search?: string }): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${env.apiUrl}/api/v1/orgs/${orgId}/leave-balances/export?${params.toString()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'leave-balances.csv';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----- the comment thread of a leave request (HR and the portal share it: readers of the leave or of its request) --------

export function useLeaveComments(leaveId: string | null) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'leave-comments', { leaveId }), queryFn: async () => (await api.get<Envelope<LeaveCommentDto[]>>(`/orgs/${orgId}/leave-records/${leaveId}/comments`)).data, enabled: !!leaveId, staleTime: 15_000 });
}
export function useAddLeaveComment(leaveId: string) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => (await api.post<Envelope<LeaveCommentDto>>(`/orgs/${orgId}/leave-records/${leaveId}/comments`, { body })).data,
    onSuccess: () => { for (const e of ['leave-comments', 'leave-records', 'self-service', 'approval-request']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); },
  });
}
