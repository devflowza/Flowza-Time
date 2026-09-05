import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvitationDto, InviteMemberInput, MemberDto, PermissionDto, RoleDto, RoleInput, UpdateRoleInput } from '@flowza/contracts';
import type { z } from 'zod';
import type { updateMemberSchema } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { meQueryKey, useOrgId } from '@/features/me/use-me';

export type UpdateMemberInput = z.output<typeof updateMemberSchema>;
export type ListQuery = Record<string, string | number | boolean | undefined>;

export function useMembers(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'members', query), queryFn: () => api.get<PageEnvelope<MemberDto>>(`/orgs/${orgId}/members`, query), placeholderData: keepPreviousData });
}
export function useInvitations() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'invitations', {}), queryFn: async () => (await api.get<Envelope<InvitationDto[]>>(`/orgs/${orgId}/invitations`)).data });
}
export function useRoles() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'roles', {}), queryFn: async () => (await api.get<Envelope<RoleDto[]>>(`/orgs/${orgId}/roles`)).data, staleTime: 60_000 });
}
export function usePermissions() {
  return useQuery({ queryKey: ['permissions'], queryFn: async () => (await api.get<Envelope<PermissionDto[]>>('/permissions')).data, staleTime: 10 * 60_000 });
}

export function useMemberMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'members') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'invitations') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'roles') }); void qc.invalidateQueries({ queryKey: meQueryKey }); };
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: UpdateMemberInput }) => (await api.patch<Envelope<MemberDto>>(`/orgs/${orgId}/members/${id}`, input)).data, onSuccess: invalidate });
  const suspend = useMutation({ mutationFn: async (id: string) => (await api.delete<Envelope<MemberDto>>(`/orgs/${orgId}/members/${id}`)).data, onSuccess: invalidate });
  const invite = useMutation({ mutationFn: async (input: InviteMemberInput) => (await api.post<Envelope<InvitationDto>>(`/orgs/${orgId}/invitations`, input)).data, onSuccess: invalidate });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/invitations/${id}`), onSuccess: invalidate });
  return { update, suspend, invite, revoke };
}

export function useRoleMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'roles') }); void qc.invalidateQueries({ queryKey: meQueryKey }); };
  const create = useMutation({ mutationFn: async (input: RoleInput) => (await api.post<Envelope<RoleDto>>(`/orgs/${orgId}/roles`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: UpdateRoleInput }) => (await api.patch<Envelope<RoleDto>>(`/orgs/${orgId}/roles/${id}`, input)).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/roles/${id}`), onSuccess: invalidate });
  return { create, update, remove };
}
