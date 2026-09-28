import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AttendanceNoteDto, RegularisationDto, SelfNoteInput, SelfNoteUpdateInput, SelfPunchChannel, SelfPunchDirection, SelfPunchPreviewDto, SelfPunchPreviewInput,
  SelfPunchResultDto, SelfPunchStatusDto, SelfRegularisationInput, SelfShiftDto, SelfShiftSwapInput, SelfStatsDto, SelfieCheckinDto, ShiftSwapDto, SwapCandidateDto,
} from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';
import { SELF } from './api';

/**
 * Employee-portal attendance (HR portal Prompt 4). Every hook lives under the `self-service` query entity so a decision in
 * the approvals inbox (which invalidates that entity) refreshes the portal too.
 */
const self = (orgId: string, view: string, params: Record<string, unknown> = {}) => qk.list(orgId, SELF, { view, ...params });

export function usePunchStatus(channel: SelfPunchChannel = 'web', enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: self(orgId, 'punch-status', { channel }), queryFn: async () => (await api.get<Envelope<SelfPunchStatusDto>>(`/orgs/${orgId}/me/punch/status`, { channel })).data, staleTime: 15_000, refetchInterval: 60_000, enabled });
}

export function useMyNotes(range: { from?: string | undefined; to?: string | undefined } = {}, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: self(orgId, 'notes', range), queryFn: async () => (await api.get<Envelope<AttendanceNoteDto[]>>(`/orgs/${orgId}/me/attendance/notes`, range)).data, placeholderData: keepPreviousData, staleTime: 30_000, enabled });
}
export function useMyRegularisations(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: self(orgId, 'regularisations'), queryFn: async () => (await api.get<Envelope<RegularisationDto[]>>(`/orgs/${orgId}/me/regularisations`)).data, staleTime: 30_000, enabled });
}
export function useMySelfies(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: self(orgId, 'selfies'), queryFn: async () => (await api.get<Envelope<SelfieCheckinDto[]>>(`/orgs/${orgId}/me/selfie-checkins`)).data, staleTime: 30_000, enabled });
}
export function useMyShift() {
  const orgId = useOrgId();
  return useQuery({ queryKey: self(orgId, 'shift'), queryFn: async () => (await api.get<Envelope<SelfShiftDto>>(`/orgs/${orgId}/me/shift`)).data, staleTime: 60_000 });
}
export function useMySwaps(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: self(orgId, 'swaps'), queryFn: async () => (await api.get<Envelope<ShiftSwapDto[]>>(`/orgs/${orgId}/me/shift-swaps`)).data, staleTime: 30_000, enabled });
}
export function useSwapCandidates(date: string | null, search: string) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: self(orgId, 'swap-candidates', { date, search }),
    queryFn: async () => (await api.get<Envelope<SwapCandidateDto[]>>(`/orgs/${orgId}/me/shift-swaps/candidates`, { date, search: search || undefined })).data,
    enabled: !!date, placeholderData: keepPreviousData,
  });
}
export function useMyStats(range: '30d' | 'month' | 'year') {
  const orgId = useOrgId();
  return useQuery({ queryKey: self(orgId, 'stats', { range }), queryFn: async () => (await api.get<Envelope<SelfStatsDto>>(`/orgs/${orgId}/me/stats`, { range })).data, placeholderData: keepPreviousData, staleTime: 60_000 });
}

/** Refresh everything the portal shows after a self-service write (and the approvals views the request lands in). */
function useInvalidateSelf() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => { for (const e of [SELF, 'approvals-mine', 'approvals-inbox', 'approval-request', 'attendance-corrections']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
}

export interface PunchRequest { direction: SelfPunchDirection; channel?: SelfPunchChannel | undefined; lat?: number | undefined; lng?: number | undefined; accuracy?: number | undefined; isMock?: boolean | undefined; clientQueuedAt?: string | undefined; idempotencyKey: string }

/** POST /me/punch for a known organisation (the offline queue replays punches of the organisation they were taken in). */
export async function postPunch(orgId: string, input: PunchRequest): Promise<SelfPunchResultDto> {
  return (await api.post<Envelope<SelfPunchResultDto>>(`/orgs/${orgId}/me/punch`, { channel: 'web', ...input })).data;
}

export function usePunchMutations() {
  const orgId = useOrgId();
  const invalidate = useInvalidateSelf();
  const preview = useMutation({ mutationFn: async (input: SelfPunchPreviewInput) => (await api.post<Envelope<SelfPunchPreviewDto>>(`/orgs/${orgId}/me/punch/preview`, input)).data });
  const punch = useMutation({ mutationFn: (input: PunchRequest) => postPunch(orgId, input), onSuccess: invalidate });
  const selfie = useMutation({
    mutationFn: async ({ photo, direction, lat, lng, accuracy }: { photo: Blob; direction: SelfPunchDirection; lat?: number | undefined; lng?: number | undefined; accuracy?: number | undefined }) => {
      const form = new FormData();
      form.set('photo', photo, photo.type === 'image/png' ? 'selfie.png' : photo.type === 'image/webp' ? 'selfie.webp' : 'selfie.jpg');
      form.set('direction', direction);
      if (lat !== undefined && lng !== undefined) { form.set('lat', String(lat)); form.set('lng', String(lng)); }
      if (accuracy !== undefined) form.set('accuracy', String(accuracy));
      return (await api.post<Envelope<SelfieCheckinDto>>(`/orgs/${orgId}/me/selfie-checkin`, form)).data;
    },
    onSuccess: invalidate,
  });
  return { preview, punch, selfie };
}

export function useNoteMutations() {
  const orgId = useOrgId();
  const invalidate = useInvalidateSelf();
  const create = useMutation({ mutationFn: async (input: SelfNoteInput) => (await api.post<Envelope<AttendanceNoteDto>>(`/orgs/${orgId}/me/attendance/notes`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: SelfNoteUpdateInput }) => (await api.patch<Envelope<AttendanceNoteDto>>(`/orgs/${orgId}/me/attendance/notes/${id}`, input)).data, onSuccess: invalidate });
  return { create, update };
}

export function useRegularisationMutations() {
  const orgId = useOrgId();
  const invalidate = useInvalidateSelf();
  const create = useMutation({ mutationFn: async (input: SelfRegularisationInput) => (await api.post<Envelope<RegularisationDto>>(`/orgs/${orgId}/me/regularisations`, input)).data, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<RegularisationDto>>(`/orgs/${orgId}/me/regularisations/${id}/cancel`, {})).data, onSuccess: invalidate });
  return { create, cancel };
}

export function useSwapMutations() {
  const orgId = useOrgId();
  const invalidate = useInvalidateSelf();
  const create = useMutation({ mutationFn: async (input: SelfShiftSwapInput) => (await api.post<Envelope<ShiftSwapDto>>(`/orgs/${orgId}/me/shift-swaps`, input)).data, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<ShiftSwapDto>>(`/orgs/${orgId}/me/shift-swaps/${id}/cancel`, {})).data, onSuccess: invalidate });
  return { create, cancel };
}
