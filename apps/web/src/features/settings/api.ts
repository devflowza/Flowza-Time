import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { organizationSettingsSchema, type OrganizationDto, type OrganizationSettings, type SettingsGroup, type updateOrganizationSchema } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { meQueryKey, useOrgId } from '@/features/me/use-me';

export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;
/** The API validates PUT /settings/:group with `organizationSettingsSchema.shape[group]` — the same object schema (minus the default wrapper) drives the form. */
export const settingsGroupSchema = <G extends SettingsGroup>(group: G) => organizationSettingsSchema.shape[group].unwrap();

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
  const putGroup = useMutation({ mutationFn: async <G extends SettingsGroup>({ group, value }: { group: G; value: OrganizationSettings[G] }) => (await api.put<Envelope<OrganizationSettings[G]>>(`/orgs/${orgId}/settings/${group}`, value)).data, onSuccess: invalidate });
  return { updateOrganization, putGroup };
}

/** Subscription is exposed by the billing module; absent (404) → informative empty state. */
export interface SubscriptionInfo { planKey: string; planName: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string | null; limits?: Record<string, unknown>; usage?: Record<string, unknown>; features?: string[] }
export function useSubscription() {
  const orgId = useOrgId();
  return useQuery({ queryKey: [...qk.org(orgId), 'subscription'], queryFn: async () => (await api.get<Envelope<SubscriptionInfo>>(`/orgs/${orgId}/subscription`)).data, retry: false, staleTime: 5 * 60_000 });
}
