import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TimeAwayKind, TimeAwayRequestDto, TimeAwayRequestInput, TimeAwayStatus, TimeAwayStatusDto } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import { SELF } from './api';

/**
 * Time away inside the working day in the portal (docs/time-away.md): the status the check-in page and the home read, the
 * employee's own requests, and the writes — a planned window, stepping out now, "I'm back", withdrawing a pending request.
 * Everything lives under the `self-service` query entity, so an approver's decision (which invalidates it) refreshes the portal.
 */
const self = (orgId: string, view: string, params: Record<string, unknown> = {}) => qk.list(orgId, SELF, { view, ...params });

/** Today's time-away state. A 4xx (no employee link, module or permission missing) is not retried: callers hide their card. */
export function useTimeAwayStatus(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: self(orgId, 'time-away-status'), queryFn: async () => (await api.get<Envelope<TimeAwayStatusDto>>(`/orgs/${orgId}/me/time-away/status`)).data, staleTime: 15_000, refetchInterval: 60_000, enabled });
}

export function useMyTimeAway(query: { from?: string | undefined; to?: string | undefined; status?: TimeAwayStatus | undefined } = {}, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: self(orgId, 'time-away', query), queryFn: async () => (await api.get<Envelope<TimeAwayRequestDto[]>>(`/orgs/${orgId}/me/time-away`, query)).data, staleTime: 30_000, enabled });
}

export interface StepOutRequest { kind: TimeAwayKind; expectedBackAt: string; reason: string; destination?: string | undefined; idempotencyKey: string }

export function useTimeAwayMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  // the portal (status, punches, requests) and the approvals views the request lands in
  const invalidate = () => { for (const e of [SELF, 'approvals-mine', 'approvals-inbox', 'approval-request']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const request = useMutation({ mutationFn: async (input: TimeAwayRequestInput) => (await api.post<Envelope<TimeAwayRequestDto>>(`/orgs/${orgId}/me/time-away`, input)).data, onSuccess: invalidate });
  const stepOut = useMutation({ mutationFn: async (input: StepOutRequest) => (await api.post<Envelope<TimeAwayRequestDto>>(`/orgs/${orgId}/me/time-away/step-out`, { ...input, channel: 'web' })).data, onSuccess: invalidate });
  // "I'm back" refreshes on failure too: a refusal (NOT_AWAY after a return on the terminal) or a lost response leaves the
  // away banner stale otherwise
  const back = useMutation({ mutationFn: async (idempotencyKey: string) => (await api.post<Envelope<TimeAwayRequestDto>>(`/orgs/${orgId}/me/time-away/back`, { channel: 'web', idempotencyKey })).data, onSettled: invalidate });
  const cancel = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<TimeAwayRequestDto>>(`/orgs/${orgId}/me/time-away/${id}/cancel`, {})).data, onSuccess: invalidate });
  return { request, stepOut, back, cancel };
}
