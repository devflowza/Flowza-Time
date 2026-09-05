import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PayrollPeriodActionInput } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import type { PayrollJobAccepted, PayrollPeriodDto, PayrollSummaryDto } from './types';

export type ListQuery = Record<string, string | number | boolean | undefined>;

export function usePayrollPeriods(query: { year: number; branchId?: string }) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'payroll-periods', query), queryFn: async () => (await api.get<Envelope<PayrollPeriodDto[]>>(`/orgs/${orgId}/payroll/periods`, query)).data, placeholderData: keepPreviousData });
}
export function usePayrollSummaries(query: ListQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'payroll-summaries', query), queryFn: () => api.get<PageEnvelope<PayrollSummaryDto>>(`/orgs/${orgId}/payroll/summaries`, query), placeholderData: keepPreviousData, enabled });
}
export function usePayrollMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'payroll-periods') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'payroll-summaries') }); };
  const build = useMutation({ mutationFn: async (input: PayrollPeriodActionInput) => (await api.post<Envelope<PayrollJobAccepted>>(`/orgs/${orgId}/payroll/periods/build`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  const finalize = useMutation({ mutationFn: async (input: PayrollPeriodActionInput) => (await api.post<Envelope<PayrollJobAccepted>>(`/orgs/${orgId}/payroll/periods/finalize`, input, { idempotencyKey: crypto.randomUUID() })).data, onSuccess: invalidate });
  return { build, finalize };
}
