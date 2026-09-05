import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BranchDto, DepartmentDto, DesignationDto, TeamDto } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

export type StructureEntity = 'branches' | 'departments' | 'designations' | 'teams';
export type ListQuery = Record<string, string | number | boolean | undefined>;

export function useStructureList<T>(entity: StructureEntity, query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, entity, query),
    queryFn: () => api.get<PageEnvelope<T>>(`/orgs/${orgId}/${entity}`, query),
    placeholderData: keepPreviousData,
    enabled,
  });
}
export const useBranches = (q: ListQuery, enabled = true) => useStructureList<BranchDto>('branches', q, enabled);
export const useDepartments = (q: ListQuery, enabled = true) => useStructureList<DepartmentDto>('departments', q, enabled);
export const useDesignations = (q: ListQuery, enabled = true) => useStructureList<DesignationDto>('designations', q, enabled);
export const useTeams = (q: ListQuery, enabled = true) => useStructureList<TeamDto>('teams', q, enabled);

export function useTeam(id: string | null) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, 'teams', id ?? ''), queryFn: async () => (await api.get<Envelope<TeamDto>>(`/orgs/${orgId}/teams/${id}`)).data, enabled: !!id });
}

/** Create / update / archive for one structure entity. Archive is a DELETE that flips status to `archived` on the server. */
export function useStructureMutations<TDto, TInput>(entity: StructureEntity) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.entity(orgId, entity) });
  const create = useMutation({ mutationFn: async (input: TInput) => (await api.post<Envelope<TDto>>(`/orgs/${orgId}/${entity}`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: Partial<TInput> }) => (await api.patch<Envelope<TDto>>(`/orgs/${orgId}/${entity}/${id}`, input)).data, onSuccess: invalidate });
  const archive = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<TDto>>(`/orgs/${orgId}/${entity}/${id}`)).data, onSuccess: invalidate });
  return { create, update, archive };
}

/** Holiday calendars are owned by the schedule module; the query is optional (feature may not be deployed yet). */
export interface HolidayCalendarRef { id: string; name: string; isDefault?: boolean }
export function useHolidayCalendars() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'holiday-calendars', {}),
    queryFn: async () => {
      const res = await api.get<Envelope<HolidayCalendarRef[]> | PageEnvelope<HolidayCalendarRef>>(`/orgs/${orgId}/holiday-calendars`, { pageSize: 200 });
      return Array.isArray(res.data) ? res.data : [];
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
}
