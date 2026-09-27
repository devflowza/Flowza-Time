import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FinanceIntegrationDto, FinanceIntegrationInput, FinanceIntegrationStatusDto, FinanceIntegrationTestDto, FinanceIntegrationTestInput, FinanceSyncNowDto } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

/** Settings → Integrations → Flowza Finance. All endpoints sit behind `integration.manage`; the token is only ever returned masked. */
export const financeKeys = {
  integration: (orgId: string) => [...qk.org(orgId), 'integrations', 'finance'] as const,
  status: (orgId: string) => [...qk.org(orgId), 'integrations', 'finance', 'status'] as const,
};

/** `enabled` = the caller holds integration.manage (the endpoint would answer 403 otherwise, so it is not even asked). */
export function useFinanceIntegration(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: financeKeys.integration(orgId), queryFn: async () => (await api.get<Envelope<FinanceIntegrationDto>>(`/orgs/${orgId}/integrations/finance`)).data, enabled });
}

export function useFinanceStatus(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: financeKeys.status(orgId), queryFn: async () => (await api.get<Envelope<FinanceIntegrationStatusDto>>(`/orgs/${orgId}/integrations/finance/status`)).data, enabled, refetchInterval: 30_000 });
}

export function useFinanceIntegrationMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: financeKeys.integration(orgId) }); void qc.invalidateQueries({ queryKey: financeKeys.status(orgId) }); };
  const save = useMutation({ mutationFn: async (input: FinanceIntegrationInput) => (await api.put<Envelope<FinanceIntegrationDto>>(`/orgs/${orgId}/integrations/finance`, input)).data, onSuccess: invalidate });
  const test = useMutation({ mutationFn: async (input: FinanceIntegrationTestInput) => (await api.post<Envelope<FinanceIntegrationTestDto>>(`/orgs/${orgId}/integrations/finance/test`, input)).data });
  const syncNow = useMutation({ mutationFn: async () => (await api.post<Envelope<FinanceSyncNowDto>>(`/orgs/${orgId}/integrations/finance/sync-now`, {})).data, onSuccess: invalidate });
  return { save, test, syncNow };
}
