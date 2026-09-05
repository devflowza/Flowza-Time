import { useMemo } from 'react';
import type { ComboboxOption } from '@/components/forms';
import { useBranches, useDepartments, useDesignations } from './api';

/**
 * Option lists for Combobox/Select controls across features (employees, users, audit…).
 * Structure lists are small (hundreds at most), so one page of 200 active rows is loaded and cached.
 */
export function useBranchOptions(includeArchived = false) {
  const q = useBranches({ pageSize: 200, sort: 'name', ...(includeArchived ? {} : { status: 'active' }) });
  const options = useMemo<ComboboxOption[]>(() => (q.data?.data ?? []).map((b) => ({ value: b.id, label: b.name, description: b.code })), [q.data]);
  const byId = useMemo(() => new Map((q.data?.data ?? []).map((b) => [b.id, b])), [q.data]);
  return { options, byId, isLoading: q.isLoading, data: q.data?.data ?? [] };
}

export function useDepartmentOptions(branchId?: string | null) {
  const q = useDepartments({ pageSize: 200, sort: 'name', status: 'active', branchId: branchId ?? undefined });
  const options = useMemo<ComboboxOption[]>(() => (q.data?.data ?? []).map((d) => ({ value: d.id, label: d.name, description: d.branchName ?? d.code })), [q.data]);
  const byId = useMemo(() => new Map((q.data?.data ?? []).map((d) => [d.id, d])), [q.data]);
  return { options, byId, isLoading: q.isLoading, data: q.data?.data ?? [] };
}

export function useDesignationOptions() {
  const q = useDesignations({ pageSize: 200, sort: 'name', status: 'active' });
  const options = useMemo<ComboboxOption[]>(() => (q.data?.data ?? []).map((d) => ({ value: d.id, label: d.name, description: d.code })), [q.data]);
  return { options, isLoading: q.isLoading, data: q.data?.data ?? [] };
}
