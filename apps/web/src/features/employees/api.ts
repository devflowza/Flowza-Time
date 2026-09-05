import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BulkEmployeeAction, CreateEmployeeInput, DeleteEmployeeInput, EmployeeDeviceStateDto, EmployeeDto, EmploymentHistoryDto, IdentityDocumentDto, ImportJobDto, ImportJobRowDto, ImportUploadInput, JobAccepted, UpdateEmployeeInput } from '@flowza/contracts';
import type { z } from 'zod';
import type { identityDocumentInputSchema } from '@flowza/contracts';
import type { ComboboxOption } from '@/components/forms';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';
import { env } from '@/lib/env';
import { useDebounced } from '@/hooks/use-debounced';
import { useOrgId } from '@/features/me/use-me';

export type EmployeeQuery = Record<string, string | number | boolean | undefined>;
export type EmployeeDetail = EmployeeDto & { currentHistory: EmploymentHistoryDto | null };
export type IdentityDocumentInput = z.input<typeof identityDocumentInputSchema>;
export type BulkResult = { kind: 'job'; jobId: string } | { kind: 'sync'; updated: number; employeeIds: string[] };

const ENTITY = 'employees';

export function useEmployees(query: EmployeeQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, ENTITY, query), queryFn: () => api.get<PageEnvelope<EmployeeDto>>(`/orgs/${orgId}/employees`, query), placeholderData: keepPreviousData, enabled });
}
export function useEmployee(id: string | undefined) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, ENTITY, id ?? ''), queryFn: async () => (await api.get<Envelope<EmployeeDetail>>(`/orgs/${orgId}/employees/${id}`)).data, enabled: !!id });
}
export function useEmployeeHistory(id: string) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.detail(orgId, ENTITY, id), 'history'], queryFn: async () => (await api.get<Envelope<EmploymentHistoryDto[]>>(`/orgs/${orgId}/employees/${id}/history`)).data });
}
export function useEmployeeDevices(id: string) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.detail(orgId, ENTITY, id), 'devices'], queryFn: async () => (await api.get<Envelope<EmployeeDeviceStateDto[]>>(`/orgs/${orgId}/employees/${id}/devices`)).data, refetchInterval: 30_000 });
}
export function useEmployeeDocuments(id: string, enabled: boolean) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.detail(orgId, ENTITY, id), 'documents'], queryFn: async () => (await api.get<Envelope<IdentityDocumentDto[]>>(`/orgs/${orgId}/employees/${id}/documents`)).data, enabled });
}

/** Searchable employee options (manager pickers, team members…). Server-side search, debounced. */
export function useEmployeeOptions(initialSearch = '') {
  const [search, setSearch] = useState(initialSearch);
  const debounced = useDebounced(search, 250);
  const q = useEmployees({ search: debounced || undefined, pageSize: 20, sort: 'displayName', employmentStatus: undefined });
  const options = useMemo<ComboboxOption[]>(() => (q.data?.data ?? []).map((e) => ({ value: e.id, label: e.displayName, description: e.employeeNumber })), [q.data]);
  return { options, setSearch, isLoading: q.isLoading || q.isFetching, data: q.data?.data ?? [] };
}

export function useEmployeeMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidateAll = () => qc.invalidateQueries({ queryKey: qk.entity(orgId, ENTITY) });
  const create = useMutation({ mutationFn: async (input: CreateEmployeeInput) => (await api.post<Envelope<EmployeeDto>>(`/orgs/${orgId}/employees`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidateAll });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: UpdateEmployeeInput }) => (await api.patch<Envelope<EmployeeDto>>(`/orgs/${orgId}/employees/${id}`, input)).data, onSuccess: invalidateAll });
  const remove = useMutation({ mutationFn: async ({ id, input }: { id: string; input?: DeleteEmployeeInput }) => (await api.post<Envelope<EmployeeDto>>(`/orgs/${orgId}/employees/${id}`, undefined, { method: 'DELETE', body: input })).data, onSuccess: invalidateAll });
  const bulk = useMutation({
    mutationFn: async (input: BulkEmployeeAction): Promise<BulkResult> => {
      const res = await api.post<Envelope<JobAccepted | { updated: number; employeeIds: string[] }>>(`/orgs/${orgId}/employees/bulk`, input, { idempotencyKey: crypto.randomUUID() });
      return 'jobId' in res.data ? { kind: 'job', jobId: res.data.jobId } : { kind: 'sync', updated: res.data.updated, employeeIds: res.data.employeeIds };
    },
    onSuccess: invalidateAll,
  });
  const addDocument = useMutation({ mutationFn: async ({ id, input }: { id: string; input: IdentityDocumentInput }) => (await api.post<Envelope<IdentityDocumentDto>>(`/orgs/${orgId}/employees/${id}/documents`, input)).data, onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: [...qk.detail(orgId, ENTITY, v.id), 'documents'] }) });
  const deleteDocument = useMutation({ mutationFn: ({ id, documentId }: { id: string; documentId: string }) => api.delete<void>(`/orgs/${orgId}/employees/${id}/documents/${documentId}`), onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: [...qk.detail(orgId, ENTITY, v.id), 'documents'] }) });
  return { create, update, remove, bulk, addDocument, deleteDocument };
}

// ---- Imports -------------------------------------------------------------------------------------------------------

export type ImportDetail = ImportJobDto & { rows: ImportJobRowDto[] };

export function useImportJob(id: string | undefined, rowsQuery: Record<string, string | number | undefined>, poll = false) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: [...qk.detail(orgId, 'employee-imports', id ?? ''), rowsQuery],
    queryFn: () => api.get<PageEnvelope<ImportJobRowDto> & { data: ImportDetail }>(`/orgs/${orgId}/employees/imports/${id}`, rowsQuery),
    enabled: !!id,
    placeholderData: keepPreviousData,
    refetchInterval: poll ? 5_000 : false,
  });
}
export function useImportMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.entity(orgId, 'employee-imports') });
  const upload = useMutation({ mutationFn: async (input: ImportUploadInput) => (await api.post<Envelope<ImportJobDto>>(`/orgs/${orgId}/employees/imports`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  const confirm = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<JobAccepted>>(`/orgs/${orgId}/employees/imports/${id}/confirm`, undefined, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: qk.entity(orgId, ENTITY) }); } });
  const cancel = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<ImportJobDto>>(`/orgs/${orgId}/employees/imports/${id}/cancel`)).data, onSuccess: invalidate });
  return { upload, confirm, cancel };
}

/** The template is served as text/csv behind auth, so it is fetched with the bearer token and saved as a Blob. */
export async function downloadImportTemplate(orgId: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`${env.apiUrl}/api/v1/orgs/${orgId}/employees/imports/template`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Template download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'employees-import-template.csv'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => { const result = String(reader.result ?? ''); resolve(result.slice(result.indexOf(',') + 1)); };
    reader.readAsDataURL(file);
  });
}
