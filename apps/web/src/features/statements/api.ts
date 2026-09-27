import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicStatementDto, PublicStatementSubmitInput, StatementDetailDto, StatementListItemDto, StatementsIssueAcceptedDto } from '@flowza/contracts';
import { api, ApiError, NETWORK_ERROR_STATUS, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { env } from '@/lib/env';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

export type ListQuery = Record<string, string | number | boolean | undefined>;

export function useStatements(query: ListQuery) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'statements', query),
    queryFn: () => api.get<PageEnvelope<StatementListItemDto>>(`/orgs/${orgId}/statements`, query),
    placeholderData: keepPreviousData,
  });
}

export function useStatement(id: string | undefined) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.detail(orgId, 'statements', id ?? ''),
    queryFn: async () => (await api.get<Envelope<StatementDetailDto>>(`/orgs/${orgId}/statements/${id}`)).data,
    enabled: !!id,
  });
}

export function useStatementMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'statements') }); };
  const issue = useMutation({
    mutationFn: async (input: { month: string; employeeIds?: string[] }) =>
      (await api.post<Envelope<StatementsIssueAcceptedDto>>(`/orgs/${orgId}/statements/issue`, input, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: invalidate,
  });
  const approve = useMutation({
    mutationFn: async (input: { id: string; note?: string }) =>
      (await api.post<Envelope<StatementDetailDto>>(`/orgs/${orgId}/statements/${input.id}/approve`, { note: input.note || undefined }, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: invalidate,
  });
  const resend = useMutation({
    mutationFn: async (id: string) =>
      (await api.post<Envelope<{ jobId: string; status: 'QUEUED' }>>(`/orgs/${orgId}/statements/${id}/resend`, {}, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: invalidate,
  });
  const voidStatement = useMutation({
    mutationFn: async (input: { id: string; reason: string }) =>
      (await api.post<Envelope<StatementDetailDto>>(`/orgs/${orgId}/statements/${input.id}/void`, { reason: input.reason }, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: invalidate,
  });
  return { issue, approve, resend, voidStatement };
}

/* ── Public (tokenized) portal client — no auth, no org context ────────────────────────────────────────────────── */

async function portalPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/api/portal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(NETWORK_ERROR_STATUS, 'NETWORK_ERROR', `Could not reach the API at ${env.apiUrl}`, undefined, { cause: cause instanceof Error ? cause.message : String(cause) });
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? (JSON.parse(text) as unknown) : null; } catch { /* status carries the failure */ }
  if (!res.ok) {
    const err = (json ?? {}) as { code?: string; message?: string; requestId?: string; details?: Record<string, unknown> };
    throw new ApiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? res.statusText, err.requestId, err.details);
  }
  return (json as { data: T }).data;
}

export const viewStatementByToken = (token: string) => portalPost<PublicStatementDto>('/statements/view', { token });
export const submitStatementByToken = (input: PublicStatementSubmitInput) => portalPost<PublicStatementDto>('/statements/submit', input);
