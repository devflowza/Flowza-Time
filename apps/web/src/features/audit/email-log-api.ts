import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EmailLogSummaryDto, EmailMessageDetailDto, EmailMessageDto } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useActiveMembership, useCan, useOrgId } from '@/features/me/use-me';

export type EmailLogQuery = Record<string, string | number | undefined>;

/** The log is a monitoring page: it refreshes on its own while open. */
const REFRESH_MS = 30_000;

export function useEmailLog(query: EmailLogQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'email-log', query), queryFn: () => api.get<PageEnvelope<EmailMessageDto>>(`/orgs/${orgId}/email-log`, query), placeholderData: keepPreviousData, refetchInterval: REFRESH_MS });
}

/** The last 7 days by status, and whether e-mails are waiting for a worker that is not sending them. */
export function useEmailLogSummary() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'email-log', { summary: true }), queryFn: async () => (await api.get<Envelope<EmailLogSummaryDto>>(`/orgs/${orgId}/email-log/summary`)).data, refetchInterval: REFRESH_MS });
}

export function useEmailMessage(id: string | null) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, 'email-log', id ?? ''), enabled: !!id, queryFn: async () => (await api.get<Envelope<EmailMessageDetailDto>>(`/orgs/${orgId}/email-log/${id}`)).data, refetchInterval: REFRESH_MS });
}

/** The log names recipients across the organisation: audit.view with access to every branch (the API and RLS say the same). */
export function useCanReadEmailLog(): boolean {
  const can = useCan();
  const membership = useActiveMembership();
  return can('audit.view') && (membership?.allBranches ?? false);
}

/** The log filtered to one invitation's e-mail. */
export const emailLogOfInvitation = (invitationId: string): string => `/email-log?invitationId=${encodeURIComponent(invitationId)}`;
