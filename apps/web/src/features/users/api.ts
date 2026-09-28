import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmployeePortalAccessDto, InvitationDto, InviteMemberInput, MemberDto, PermissionDto, PortalAccessInviteInput, PortalAccessResendResultDto, RoleDto, RoleInput, UpdateRoleInput } from '@flowza/contracts';
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
  /** HR portal Prompt 6b (B-67/68): revokes the open token and issues a new 7-day invitation, e-mailed; the answer carries the new link once. */
  const resend = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<InvitationDto>>(`/orgs/${orgId}/invitations/${id}/resend`)).data, onSuccess: invalidate });
  return { update, suspend, invite, revoke, resend };
}

// ----- FlowZa Time access of one employee record (HR portal Prompt 6b, Finance B-69 / B-70 / B-74) -------------------------------

const PORTAL_ACCESS = 'portal-access';
export function usePortalAccess(employeeId: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, PORTAL_ACCESS, employeeId), queryFn: async () => (await api.get<Envelope<EmployeePortalAccessDto>>(`/orgs/${orgId}/employees/${employeeId}/portal-access`)).data, enabled, retry: false });
}
export function usePortalAccessMutations(employeeId: string) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const base = `/orgs/${orgId}/employees/${employeeId}/portal-access`;
  const invalidate = () => { for (const e of [PORTAL_ACCESS, 'members', 'invitations', 'employees']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const invite = useMutation({ mutationFn: async (input: PortalAccessInviteInput) => (await api.post<Envelope<{ invitation: InvitationDto; access: EmployeePortalAccessDto }>>(`${base}/invite`, input)).data, onSuccess: invalidate });
  const revoke = useMutation({ mutationFn: async (reason?: string) => (await api.post<Envelope<EmployeePortalAccessDto>>(`${base}/revoke`, reason ? { reason } : {})).data, onSuccess: invalidate });
  const restore = useMutation({ mutationFn: async (reason?: string) => (await api.post<Envelope<EmployeePortalAccessDto>>(`${base}/restore`, reason ? { reason } : {})).data, onSuccess: invalidate });
  const resend = useMutation({ mutationFn: async () => (await api.post<Envelope<PortalAccessResendResultDto>>(`${base}/resend`)).data, onSuccess: invalidate });
  return { invite, revoke, restore, resend };
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
