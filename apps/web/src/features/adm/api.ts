import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePlatformAdminInput, CreateTenantNoteInput, FeatureFlagDto, PlatformAdminDto, PlatformAuditEntryDto, PlatformOrganizationDto,
  PlatformOrgMembersDto, PlatformOverviewDto, PlatformSubscriptionDto, PlatformUserDetailDto, PlatformUserDto, PutTenantAccountInput, TenantAccountDto,
  TenantNoteDto, UpdateOrganizationInput, UpdatePlatformAdminInput, UpdateSubscriptionInput,
} from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { pk, type ListQuery } from '@/features/platform/api';

/** Super-admin portal queries: the same `['platform', …]` key space as the platform hooks, so their invalidations reach both. */
export const ak = {
  overview: ['platform', 'overview'] as const,
  subscription: (id: string) => ['platform', 'orgs', 'detail', id, 'subscription'] as const,
  members: (id: string) => ['platform', 'orgs', 'detail', id, 'members'] as const,
  account: (id: string) => ['platform', 'orgs', 'detail', id, 'account'] as const,
  notes: (id: string) => ['platform', 'orgs', 'detail', id, 'notes'] as const,
  activity: (query: unknown) => ['platform', 'activity', query] as const,
  users: (query: unknown) => ['platform', 'users', 'list', query] as const,
  user: (id: string) => ['platform', 'users', 'detail', id] as const,
  admins: ['platform', 'admins'] as const,
};

export function usePlatformOverview() {
  return useQuery({ queryKey: ak.overview, queryFn: async () => (await api.get<Envelope<PlatformOverviewDto>>('/platform/overview')).data, refetchInterval: 60_000 });
}
export function useTenantSubscription(id: string) {
  return useQuery({ queryKey: ak.subscription(id), queryFn: async () => (await api.get<Envelope<PlatformSubscriptionDto | null>>(`/platform/orgs/${id}/subscription`)).data });
}
export function useTenantMembers(id: string) {
  return useQuery({ queryKey: ak.members(id), queryFn: async () => (await api.get<Envelope<PlatformOrgMembersDto>>(`/platform/orgs/${id}/members`)).data });
}
export function useTenantAccount(id: string) {
  return useQuery({ queryKey: ak.account(id), queryFn: async () => (await api.get<Envelope<TenantAccountDto>>(`/platform/orgs/${id}/account`)).data });
}
export function useTenantNotes(id: string) {
  return useQuery({ queryKey: ak.notes(id), queryFn: async () => (await api.get<Envelope<TenantNoteDto[]>>(`/platform/orgs/${id}/notes`)).data });
}
export function usePlatformActivity(query: ListQuery) {
  return useQuery({ queryKey: ak.activity(query), queryFn: () => api.get<PageEnvelope<PlatformAuditEntryDto>>('/platform/activity', query), placeholderData: keepPreviousData });
}
export function usePlatformUsers(query: ListQuery) {
  return useQuery({ queryKey: ak.users(query), queryFn: () => api.get<PageEnvelope<PlatformUserDto>>('/platform/users', query), placeholderData: keepPreviousData });
}
export function usePlatformUser(id: string | null) {
  return useQuery({ queryKey: ak.user(id ?? ''), queryFn: async () => (await api.get<Envelope<PlatformUserDetailDto>>(`/platform/users/${id}`)).data, enabled: !!id });
}
export function usePlatformAdmins() {
  return useQuery({ queryKey: ak.admins, queryFn: async () => (await api.get<Envelope<PlatformAdminDto[]>>('/platform/admins')).data });
}

export function useAdmMutations() {
  const qc = useQueryClient();
  const touchOrg = (id: string) => { void qc.invalidateQueries({ queryKey: ['platform', 'orgs'] }); void qc.invalidateQueries({ queryKey: ak.overview }); void qc.invalidateQueries({ queryKey: ['platform', 'activity'] }); return id; };
  const updateDetails = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateOrganizationInput }) => (await api.patch<Envelope<PlatformOrganizationDto>>(`/platform/orgs/${id}`, input)).data,
    onSuccess: (data, v) => { qc.setQueryData(pk.org(v.id), data); touchOrg(v.id); },
  });
  const updateSubscription = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateSubscriptionInput }) => (await api.patch<Envelope<PlatformSubscriptionDto>>(`/platform/orgs/${id}/subscription`, input)).data,
    onSuccess: (data, v) => { qc.setQueryData(ak.subscription(v.id), data); touchOrg(v.id); },
  });
  const putAccount = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: PutTenantAccountInput }) => (await api.put<Envelope<TenantAccountDto>>(`/platform/orgs/${id}/account`, input)).data,
    onSuccess: (data, v) => { qc.setQueryData(ak.account(v.id), data); touchOrg(v.id); },
  });
  const addNote = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: CreateTenantNoteInput }) => (await api.post<Envelope<TenantNoteDto>>(`/platform/orgs/${id}/notes`, input)).data,
    onSuccess: (_d, v) => { void qc.invalidateQueries({ queryKey: ak.notes(v.id) }); void qc.invalidateQueries({ queryKey: ['platform', 'activity'] }); },
  });
  const addAdmin = useMutation({
    mutationFn: async (input: CreatePlatformAdminInput) => (await api.post<Envelope<PlatformAdminDto>>('/platform/admins', input)).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ak.admins }); void qc.invalidateQueries({ queryKey: ['platform', 'users'] }); void qc.invalidateQueries({ queryKey: ak.overview }); },
  });
  const updateAdmin = useMutation({
    mutationFn: async ({ userId, input }: { userId: string; input: UpdatePlatformAdminInput }) => (await api.patch<Envelope<PlatformAdminDto>>(`/platform/admins/${userId}`, input)).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ak.admins }); void qc.invalidateQueries({ queryKey: ['platform', 'users'] }); void qc.invalidateQueries({ queryKey: ak.overview }); },
  });
  const putFlags = useMutation({
    mutationFn: async (flags: Array<{ key: string; description?: string; defaultEnabled?: boolean; rolloutPercentage?: number }>) => (await api.put<Envelope<FeatureFlagDto[]>>('/platform/feature-flags', { flags })).data,
    onSuccess: (data) => { qc.setQueryData(pk.flags, data); },
  });
  return { updateDetails, updateSubscription, putAccount, addNote, addAdmin, updateAdmin, putFlags };
}

