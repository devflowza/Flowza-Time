import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiKeyCreateInput, ApiKeyCreatedDto, ApiKeyDto, HrmsBatchListItem, HrmsIntegrationDto, HrmsIntegrationInput } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

/** Settings → HR system (docs/integrations/hrms.md). Every endpoint sits behind `integration.manage`; a key's secret is only in the create answer. */
export const hrmsKeys = {
  integration: (orgId: string) => [...qk.org(orgId), 'integrations', 'hrms'] as const,
  batches: (orgId: string) => [...qk.org(orgId), 'integrations', 'hrms', 'batches'] as const,
  apiKeys: (orgId: string) => [...qk.org(orgId), 'api-keys'] as const,
};

/** `enabled` = the caller holds integration.manage (the endpoint would answer 403 otherwise, so it is not even asked). */
export function useHrmsIntegration(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: hrmsKeys.integration(orgId), queryFn: async () => (await api.get<Envelope<HrmsIntegrationDto>>(`/orgs/${orgId}/integrations/hrms`)).data, enabled });
}

export function useHrmsBatches(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: hrmsKeys.batches(orgId), queryFn: async () => (await api.get<Envelope<HrmsBatchListItem[]>>(`/orgs/${orgId}/integrations/hrms/batches`)).data, enabled, refetchInterval: 60_000 });
}

export function useApiKeys(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: hrmsKeys.apiKeys(orgId), queryFn: async () => (await api.get<Envelope<ApiKeyDto[]>>(`/orgs/${orgId}/api-keys`)).data, enabled });
}

export function useHrmsMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const save = useMutation({ mutationFn: async (input: HrmsIntegrationInput) => (await api.put<Envelope<HrmsIntegrationDto>>(`/orgs/${orgId}/integrations/hrms`, input)).data, onSuccess: () => { void qc.invalidateQueries({ queryKey: hrmsKeys.integration(orgId) }); } });
  const invalidateKeys = () => { void qc.invalidateQueries({ queryKey: hrmsKeys.apiKeys(orgId) }); };
  const createKey = useMutation({ mutationFn: async (input: ApiKeyCreateInput) => (await api.post<Envelope<ApiKeyCreatedDto>>(`/orgs/${orgId}/api-keys`, input)).data, onSuccess: invalidateKeys });
  const revokeKey = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<ApiKeyDto>>(`/orgs/${orgId}/api-keys/${id}/revoke`)).data, onSuccess: invalidateKeys });
  return { save, createKey, revokeKey };
}
