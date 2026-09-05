import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { AccessGrantDto, CreateAccessGrantInput, CreateOrganizationInput, CreateOrganizationResult, FeatureFlagDto, OrgFeatureFlagDto, PlanDto, PlatformHealthDto, PlatformOrganizationDto, putOrgFeatureFlagsSchema, updateOrganizationStatusSchema } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';

export type ListQuery = Record<string, string | number | boolean | undefined>;
export type StatusInput = z.infer<typeof updateOrganizationStatusSchema>;
export type OrgFlagsInput = z.infer<typeof putOrgFeatureFlagsSchema>;

/** Platform queries live outside the per-organisation key space (`['platform', …]`). */
export const pk = {
  all: ['platform'] as const,
  orgs: (query?: unknown) => ['platform', 'orgs', 'list', query ?? {}] as const,
  org: (id: string) => ['platform', 'orgs', 'detail', id] as const,
  orgFlags: (id: string) => ['platform', 'orgs', 'detail', id, 'flags'] as const,
  grants: (query?: unknown) => ['platform', 'grants', query ?? {}] as const,
  plans: ['platform', 'plans'] as const,
  flags: ['platform', 'flags'] as const,
  health: ['platform', 'health'] as const,
};

export function usePlatformOrgs(query: ListQuery) {
  return useQuery({ queryKey: pk.orgs(query), queryFn: () => api.get<PageEnvelope<PlatformOrganizationDto>>('/platform/orgs', query), placeholderData: keepPreviousData });
}
export function usePlatformOrg(id: string | undefined) {
  return useQuery({ queryKey: pk.org(id ?? ''), queryFn: async () => (await api.get<Envelope<PlatformOrganizationDto>>(`/platform/orgs/${id}`)).data, enabled: !!id });
}
export function useOrgFeatureFlags(id: string | undefined) {
  return useQuery({ queryKey: pk.orgFlags(id ?? ''), queryFn: async () => (await api.get<Envelope<OrgFeatureFlagDto[]>>(`/platform/orgs/${id}/feature-flags`)).data, enabled: !!id });
}
export function useAccessGrants(query: ListQuery) {
  return useQuery({ queryKey: pk.grants(query), queryFn: () => api.get<PageEnvelope<AccessGrantDto>>('/platform/access-grants', query), placeholderData: keepPreviousData });
}
export function usePlans() {
  return useQuery({ queryKey: pk.plans, queryFn: async () => (await api.get<Envelope<PlanDto[]>>('/platform/plans')).data, staleTime: 5 * 60_000 });
}
export function usePlatformFeatureFlags() {
  return useQuery({ queryKey: pk.flags, queryFn: async () => (await api.get<Envelope<FeatureFlagDto[]>>('/platform/feature-flags')).data });
}
export function usePlatformHealth() {
  return useQuery({ queryKey: pk.health, queryFn: async () => (await api.get<Envelope<PlatformHealthDto>>('/platform/health')).data, refetchInterval: 15_000 });
}

export function usePlatformMutations() {
  const qc = useQueryClient();
  const invalidateOrgs = () => qc.invalidateQueries({ queryKey: ['platform', 'orgs'] });
  const createOrg = useMutation({ mutationFn: async (input: CreateOrganizationInput) => (await api.post<Envelope<CreateOrganizationResult>>('/platform/orgs', input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidateOrgs });
  const updateStatus = useMutation({ mutationFn: async ({ id, input }: { id: string; input: StatusInput }) => (await api.patch<Envelope<PlatformOrganizationDto>>(`/platform/orgs/${id}/status`, input)).data, onSuccess: invalidateOrgs });
  const putOrgFlags = useMutation({ mutationFn: async ({ id, input }: { id: string; input: OrgFlagsInput }) => (await api.put<Envelope<OrgFeatureFlagDto[]>>(`/platform/orgs/${id}/feature-flags`, input)).data, onSuccess: (data, v) => { qc.setQueryData(pk.orgFlags(v.id), data); } });
  const createGrant = useMutation({ mutationFn: async (input: CreateAccessGrantInput) => (await api.post<Envelope<AccessGrantDto>>('/platform/access-grants', input)).data, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['platform', 'grants'] }); void qc.invalidateQueries({ queryKey: pk.health }); } });
  const revokeGrant = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<AccessGrantDto>>(`/platform/access-grants/${id}`)).data, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['platform', 'grants'] }); void qc.invalidateQueries({ queryKey: pk.health }); } });
  return { createOrg, updateStatus, putOrgFlags, createGrant, revokeGrant };
}
