import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplyModuleToAllInput, ApplyModuleToAllResult, BillingInvoiceDto, BillingPaymentDto, BillingSummaryDto, CreateInvoiceInput, CreatePlanInput,
  OrgModuleStateDto, PlatformModuleDto, PlatformPlanDto, PlatformSettingsDto, PutOrgModulesInput, PutPlatformSettingsInput, RecordPaymentInput,
  UpdatePlanInput, UpdatePlatformModuleInput, VoidInvoiceInput,
} from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { pk, type ListQuery } from '@/features/platform/api';

/**
 * Modules, plans & pricing, billing and platform settings (migration 20260929000600) — the `['platform', …]` key space, so the
 * platform hooks' invalidations reach these too.
 */
export const bk = {
  modules: ['platform', 'modules'] as const,
  orgModules: (id: string) => ['platform', 'orgs', 'detail', id, 'modules'] as const,
  summary: ['platform', 'billing', 'summary'] as const,
  invoices: (query: unknown) => ['platform', 'billing', 'invoices', query] as const,
  invoice: (id: string) => ['platform', 'billing', 'invoice', id] as const,
  payments: (query: unknown) => ['platform', 'billing', 'payments', query] as const,
  settings: ['platform', 'settings'] as const,
};

export function usePlatformModules() {
  return useQuery({ queryKey: bk.modules, queryFn: async () => (await api.get<Envelope<PlatformModuleDto[]>>('/platform/modules')).data });
}
export function useOrgModules(id: string) {
  return useQuery({ queryKey: bk.orgModules(id), queryFn: async () => (await api.get<Envelope<OrgModuleStateDto[]>>(`/platform/orgs/${id}/modules`)).data, enabled: !!id });
}
/** Plans with pricing, modules and subscriber counts (the super-admin view of GET /platform/plans). */
export function usePlatformPlans() {
  return useQuery({ queryKey: pk.plans, queryFn: async () => (await api.get<Envelope<PlatformPlanDto[]>>('/platform/plans')).data });
}
export function useBillingSummary() {
  return useQuery({ queryKey: bk.summary, queryFn: async () => (await api.get<Envelope<BillingSummaryDto>>('/platform/billing/summary')).data, refetchInterval: 120_000 });
}
export function useInvoices(query: ListQuery) {
  return useQuery({ queryKey: bk.invoices(query), queryFn: () => api.get<PageEnvelope<BillingInvoiceDto>>('/platform/billing/invoices', query), placeholderData: keepPreviousData });
}
export function useInvoice(id: string | null) {
  return useQuery({ queryKey: bk.invoice(id ?? ''), queryFn: async () => (await api.get<Envelope<BillingInvoiceDto>>(`/platform/billing/invoices/${id}`)).data, enabled: !!id });
}
export function usePayments(query: ListQuery) {
  return useQuery({ queryKey: bk.payments(query), queryFn: () => api.get<PageEnvelope<BillingPaymentDto>>('/platform/billing/payments', query), placeholderData: keepPreviousData });
}
export function usePlatformSettings() {
  return useQuery({ queryKey: bk.settings, queryFn: async () => (await api.get<Envelope<PlatformSettingsDto>>('/platform/settings')).data });
}

export function useBillingMutations() {
  const qc = useQueryClient();
  const touch = (...keys: ReadonlyArray<readonly unknown[]>) => { for (const k of keys) void qc.invalidateQueries({ queryKey: k }); void qc.invalidateQueries({ queryKey: ['platform', 'activity'] }); };
  const billing = ['platform', 'billing'] as const;
  const orgs = ['platform', 'orgs'] as const;
  const updateModule = useMutation({
    mutationFn: async ({ key, input }: { key: string; input: UpdatePlatformModuleInput }) => (await api.patch<Envelope<PlatformModuleDto>>(`/platform/modules/${key}`, input)).data,
    onSuccess: () => touch(bk.modules, orgs),
  });
  const applyModuleToAll = useMutation({
    mutationFn: async ({ key, input }: { key: string; input: ApplyModuleToAllInput }) => (await api.post<Envelope<ApplyModuleToAllResult>>(`/platform/modules/${key}/apply-all`, input, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: () => touch(bk.modules, orgs),
  });
  const putOrgModules = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: PutOrgModulesInput }) => (await api.put<Envelope<OrgModuleStateDto[]>>(`/platform/orgs/${id}/modules`, input)).data,
    onSuccess: (data, v) => { qc.setQueryData(bk.orgModules(v.id), data); touch(bk.modules); },
  });
  const createPlan = useMutation({
    mutationFn: async (input: CreatePlanInput) => (await api.post<Envelope<PlatformPlanDto>>('/platform/plans', input, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: () => touch(pk.plans, bk.modules),
  });
  const updatePlan = useMutation({
    mutationFn: async ({ key, input }: { key: string; input: UpdatePlanInput }) => (await api.patch<Envelope<PlatformPlanDto>>(`/platform/plans/${key}`, input)).data,
    onSuccess: () => touch(pk.plans, bk.modules, billing, orgs),
  });
  const createInvoice = useMutation({
    mutationFn: async (input: CreateInvoiceInput) => (await api.post<Envelope<BillingInvoiceDto>>('/platform/billing/invoices', input, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: () => touch(billing, orgs),
  });
  const recordPayment = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: RecordPaymentInput }) => (await api.post<Envelope<BillingInvoiceDto>>(`/platform/billing/invoices/${id}/payments`, input, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: (data) => { qc.setQueryData(bk.invoice(data.id), data); touch(billing, orgs, bk.modules); },
  });
  const voidInvoice = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: VoidInvoiceInput }) => (await api.post<Envelope<BillingInvoiceDto>>(`/platform/billing/invoices/${id}/void`, input)).data,
    onSuccess: (data) => { qc.setQueryData(bk.invoice(data.id), data); touch(billing); },
  });
  const putSettings = useMutation({
    mutationFn: async (input: PutPlatformSettingsInput) => (await api.put<Envelope<PlatformSettingsDto>>('/platform/settings', input)).data,
    onSuccess: (data) => { qc.setQueryData(bk.settings, data); touch(); },
  });
  return { updateModule, applyModuleToAll, putOrgModules, createPlan, updatePlan, createInvoice, recordPayment, voidInvoice, putSettings };
}
