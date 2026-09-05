import { useMemo } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { AttendanceRuleSetInput, HolidayInput, ShiftAssignmentInput, ShiftInput, ShiftPatternInput, holidayCalendarInputSchema } from '@flowza/contracts';
import type { ComboboxOption } from '@/components/forms';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import type { HolidayCalendarDto, HolidayDto, RuleSetDto, ShiftAssignmentDto, ShiftDto, ShiftPatternDto, ShiftResolution, WithRecalc } from './types';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type HolidayCalendarInput = z.infer<typeof holidayCalendarInputSchema>;

// ---- shifts -----------------------------------------------------------------------------------------------------------
export function useShifts(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'shifts', query), queryFn: () => api.get<PageEnvelope<ShiftDto>>(`/orgs/${orgId}/shifts`, query), placeholderData: keepPreviousData, enabled });
}
/** Active shifts as Combobox options (small list; one page of 200). */
export function useShiftOptions(includeInactive = false) {
  const q = useShifts({ pageSize: 200, sort: 'name', ...(includeInactive ? {} : { status: 'active' }) });
  const options = useMemo<ComboboxOption[]>(() => (q.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, description: s.code })), [q.data]);
  const byId = useMemo(() => new Map((q.data?.data ?? []).map((s) => [s.id, s])), [q.data]);
  return { options, byId, isLoading: q.isLoading, isError: q.isError, error: q.error, refetch: q.refetch, data: q.data?.data ?? [] };
}
export function useShiftResolution(params: { employeeId: string | null; date: string }) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'shift-resolve', params), queryFn: async () => (await api.get<Envelope<ShiftResolution>>(`/orgs/${orgId}/shifts/resolve`, { employeeId: params.employeeId ?? undefined, date: params.date })).data, enabled: !!params.employeeId && !!params.date, retry: false });
}
export function useShiftMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'shifts') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'shift-resolve') }); };
  const create = useMutation({ mutationFn: async (input: ShiftInput) => (await api.post<Envelope<ShiftDto>>(`/orgs/${orgId}/shifts`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<ShiftInput> }) => (await api.patch<Envelope<ShiftDto>>(`/orgs/${orgId}/shifts/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/shifts/${id}`), onSuccess: invalidate });
  return { create, update, remove };
}

// ---- patterns ---------------------------------------------------------------------------------------------------------
export function usePatterns() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'shift-patterns', {}), queryFn: async () => (await api.get<Envelope<ShiftPatternDto[]>>(`/orgs/${orgId}/shift-patterns`)).data });
}
export function usePatternMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'shift-patterns') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'shift-resolve') }); };
  const create = useMutation({ mutationFn: async (input: ShiftPatternInput) => (await api.post<Envelope<ShiftPatternDto>>(`/orgs/${orgId}/shift-patterns`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<ShiftPatternInput> }) => (await api.patch<Envelope<ShiftPatternDto>>(`/orgs/${orgId}/shift-patterns/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/shift-patterns/${id}`), onSuccess: invalidate });
  return { create, update, remove };
}

// ---- assignments ------------------------------------------------------------------------------------------------------
export function useAssignments(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'shift-assignments', query), queryFn: () => api.get<PageEnvelope<ShiftAssignmentDto>>(`/orgs/${orgId}/shift-assignments`, query), placeholderData: keepPreviousData });
}
export function useAssignmentMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'shift-assignments') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'shifts') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'shift-resolve') }); };
  const create = useMutation({ mutationFn: async (input: ShiftAssignmentInput) => (await api.post<Envelope<WithRecalc<ShiftAssignmentDto>>>(`/orgs/${orgId}/shift-assignments`, input)).data, onSuccess: invalidate });
  const end = useMutation({ mutationFn: async ({ id, effectiveTo }: { id: string; effectiveTo: string | null }) => (await api.patch<Envelope<WithRecalc<ShiftAssignmentDto>>>(`/orgs/${orgId}/shift-assignments/${id}`, { effectiveTo })).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<{ recalculationJobId: string | null }>>(`/orgs/${orgId}/shift-assignments/${id}`)).data, onSuccess: invalidate });
  return { create, end, remove };
}

// ---- rule sets --------------------------------------------------------------------------------------------------------
export function useRuleSets(query: ListQuery = {}) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-rule-sets', query), queryFn: async () => (await api.get<Envelope<RuleSetDto[]>>(`/orgs/${orgId}/attendance-rule-sets`, query)).data, placeholderData: keepPreviousData });
}
export function useRuleSetMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.entity(orgId, 'attendance-rule-sets') });
  const create = useMutation({ mutationFn: async (input: AttendanceRuleSetInput) => (await api.post<Envelope<WithRecalc<RuleSetDto>>>(`/orgs/${orgId}/attendance-rule-sets`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<AttendanceRuleSetInput> }) => (await api.patch<Envelope<WithRecalc<RuleSetDto>>>(`/orgs/${orgId}/attendance-rule-sets/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<{ recalculationJobId: string | null }>>(`/orgs/${orgId}/attendance-rule-sets/${id}`)).data, onSuccess: invalidate });
  return { create, update, remove };
}

// ---- holidays ---------------------------------------------------------------------------------------------------------
export function useHolidayCalendars() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'holiday-calendars', {}), queryFn: async () => (await api.get<Envelope<HolidayCalendarDto[]>>(`/orgs/${orgId}/holiday-calendars`)).data });
}
export function useHolidays(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'holidays', query), queryFn: async () => (await api.get<Envelope<HolidayDto[]>>(`/orgs/${orgId}/holidays`, query)).data, placeholderData: keepPreviousData, enabled });
}
export function useHolidayMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'holidays') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'holiday-calendars') }); };
  const createCalendar = useMutation({ mutationFn: async (input: HolidayCalendarInput) => (await api.post<Envelope<HolidayCalendarDto>>(`/orgs/${orgId}/holiday-calendars`, input)).data, onSuccess: invalidate });
  const updateCalendar = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<HolidayCalendarInput> }) => (await api.patch<Envelope<HolidayCalendarDto>>(`/orgs/${orgId}/holiday-calendars/${id}`, input)).data, onSuccess: invalidate });
  const removeCalendar = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/holiday-calendars/${id}`), onSuccess: invalidate });
  const createHoliday = useMutation({ mutationFn: async (input: HolidayInput) => (await api.post<Envelope<HolidayDto>>(`/orgs/${orgId}/holidays`, input)).data, onSuccess: invalidate });
  const updateHoliday = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<HolidayInput> }) => (await api.patch<Envelope<HolidayDto>>(`/orgs/${orgId}/holidays/${id}`, input)).data, onSuccess: invalidate });
  const removeHoliday = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/holidays/${id}`), onSuccess: invalidate });
  return { createCalendar, updateCalendar, removeCalendar, createHoliday, updateHoliday, removeHoliday };
}
