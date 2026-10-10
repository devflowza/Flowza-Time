import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplyLocationTemplateInput, LocationDto, LocationInput, LocationLevelDto, LocationLevelInput, UpdateLocationInput, UpdateLocationLevelInput,
} from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCan, useOrgId } from '@/features/me/use-me';

/*
 * Location hierarchy (docs/locations.md): the organisation's levels and its location tree. Both are small (≤ 8 levels,
 * ≤ 10 000 nodes) and change rarely, so every picker and filter shares one cached copy of each.
 */

/** The ordered levels (top first). Read with branch.view. */
export function useLocationLevels(enabled = true) {
  const orgId = useOrgId();
  const can = useCan();
  return useQuery({
    queryKey: qk.list(orgId, 'location-levels'),
    queryFn: async () => (await api.get<Envelope<LocationLevelDto[]>>(`/orgs/${orgId}/location-levels`)).data,
    enabled: enabled && can('branch.view'),
    staleTime: 60_000,
  });
}

/** Every location the caller may see (flat, parents before children). Read with branch.view. */
export function useLocations(opts: { includeArchived?: boolean; enabled?: boolean } = {}) {
  const orgId = useOrgId();
  const can = useCan();
  const includeArchived = opts.includeArchived ?? false;
  return useQuery({
    queryKey: qk.list(orgId, 'locations', { includeArchived }),
    queryFn: async () => (await api.get<Envelope<LocationDto[]>>(`/orgs/${orgId}/locations`, includeArchived ? { includeArchived: true } : undefined)).data,
    enabled: (opts.enabled ?? true) && can('branch.view'),
    staleTime: 30_000,
  });
}

/** Everything a level or a location change can affect: the levels, the tree, and the branch list (its placement column). */
function useInvalidateLocations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: qk.entity(orgId, 'location-levels') }),
    qc.invalidateQueries({ queryKey: qk.entity(orgId, 'locations') }),
    qc.invalidateQueries({ queryKey: qk.entity(orgId, 'branches') }),
  ]);
}

/** Level writes return the whole ordered list (an insert or a delete moves the levels below it). */
export function useLocationLevelMutations() {
  const orgId = useOrgId();
  const invalidate = useInvalidateLocations();
  const base = `/orgs/${orgId}/location-levels`;
  const create = useMutation({ mutationFn: async (input: LocationLevelInput) => (await api.post<Envelope<LocationLevelDto[]>>(base, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: UpdateLocationLevelInput }) => (await api.patch<Envelope<LocationLevelDto>>(`${base}/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<LocationLevelDto[]>>(`${base}/${id}`)).data, onSuccess: invalidate });
  const applyTemplate = useMutation({ mutationFn: async (input: ApplyLocationTemplateInput) => (await api.post<Envelope<LocationLevelDto[]>>(`${base}/apply-template`, input)).data, onSuccess: invalidate });
  return { create, update, remove, applyTemplate };
}

/** Create / update (rename, move, re-level, restore) / archive a location. */
export function useLocationMutations() {
  const orgId = useOrgId();
  const invalidate = useInvalidateLocations();
  const base = `/orgs/${orgId}/locations`;
  const create = useMutation({ mutationFn: async (input: LocationInput) => (await api.post<Envelope<LocationDto>>(base, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: UpdateLocationInput }) => (await api.patch<Envelope<LocationDto>>(`${base}/${id}`, input)).data, onSuccess: invalidate });
  const archive = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<LocationDto>>(`${base}/${id}`)).data, onSuccess: invalidate });
  return { create, update, archive };
}
