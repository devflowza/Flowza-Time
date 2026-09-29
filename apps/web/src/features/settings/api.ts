import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { BillingInvoiceDto, OrganizationDto, OrganizationSettings, SettingsGroup, TenantSubscriptionDto, updateOrganizationSchema } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { meQueryKey, useOrgId } from '@/features/me/use-me';

export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;
/** The API validates PUT /settings/:group with `organizationSettingsSchema.shape[group]`; forms use the same object schema via `.unwrap()` (drops the default wrapper). */

export function useOrganization() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.org(orgId), queryFn: async () => (await api.get<Envelope<OrganizationDto>>(`/orgs/${orgId}`)).data });
}
export function useSettingsGroup<G extends SettingsGroup>(group: G) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.org(orgId), 'settings', group], queryFn: async () => (await api.get<Envelope<OrganizationSettings[G]>>(`/orgs/${orgId}/settings/${group}`)).data });
}
export function useSettingsMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.org(orgId) }); void qc.invalidateQueries({ queryKey: meQueryKey }); };
  const updateOrganization = useMutation({ mutationFn: async (input: UpdateOrganizationInput) => (await api.patch<Envelope<OrganizationDto>>(`/orgs/${orgId}`, input)).data, onSuccess: invalidate });
  const putGroup = useMutation({ mutationFn: async ({ group, value }: { group: SettingsGroup; value: OrganizationSettings[SettingsGroup] }) => (await api.put<Envelope<OrganizationSettings[SettingsGroup]>>(`/orgs/${orgId}/settings/${group}`, value)).data, onSuccess: invalidate });
  return { updateOrganization, putGroup };
}

/**
 * The organisation's plan, price, usage, modules and the plans it could move to (GET /orgs/:orgId/subscription, organization.view)
 * and its invoices (organization.manage) — migration 20260929000600. A 404 / 403 (an API deployed before it) reads as unavailable.
 */
export function useSubscription() {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.org(orgId), 'subscription'], queryFn: async () => (await api.get<Envelope<TenantSubscriptionDto>>(`/orgs/${orgId}/subscription`)).data, retry: false, staleTime: 5 * 60_000 });
}
export function useTenantInvoices(enabled: boolean) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.org(orgId), 'billing', 'invoices'], queryFn: async () => (await api.get<Envelope<BillingInvoiceDto[]>>(`/orgs/${orgId}/billing/invoices`)).data, enabled, retry: false });
}
