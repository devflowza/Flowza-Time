import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessEventDto, MeetingDetailDto, MeetingDto, MeetingInput, MeetingRoomDto, MeetingRoomInput, MeetingRoomUpdateInput } from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

/*
 * Meeting rooms & access (Enterprise, module meeting_rooms — docs/time-away.md §4): TanStack Query hooks over
 * /orgs/:orgId/{meeting-rooms, meetings, access-events}. Attendance of a meeting is derived by the API from the room's entries,
 * so the meeting views poll while they are open (a reader's punch reaches them within a minute).
 */

export const ROOMS = 'meeting-rooms';
export const MEETINGS = 'meetings';
export const ACCESS_EVENTS = 'access-events';
/** How often the meetings list and an open meeting refresh while visible. */
export const MEETINGS_REFRESH_MS = 60_000;

export function useMeetingRooms(enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, ROOMS), queryFn: async () => (await api.get<Envelope<MeetingRoomDto[]>>(`/orgs/${orgId}/meeting-rooms`)).data, enabled, staleTime: 30_000 });
}

export function useMeetingRoomMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  // a room's name / restriction shows on its meetings and decides who is unauthorised in the access log
  const invalidate = () => { for (const e of [ROOMS, MEETINGS, ACCESS_EVENTS]) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const create = useMutation({ mutationFn: async (input: MeetingRoomInput) => (await api.post<Envelope<MeetingRoomDto>>(`/orgs/${orgId}/meeting-rooms`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: MeetingRoomUpdateInput }) => (await api.patch<Envelope<MeetingRoomDto>>(`/orgs/${orgId}/meeting-rooms/${id}`, input)).data, onSuccess: invalidate });
  return { create, update };
}

export interface MeetingsQuery { from: string; to: string; roomId?: string | undefined; includeCancelled?: boolean | undefined }
/** The meetings starting in [from, to] (dates); the API widens the window by the timezone spread, the page keeps its own days. */
export function useMeetings(query: MeetingsQuery) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, MEETINGS, query),
    queryFn: async () => (await api.get<Envelope<MeetingDto[]>>(`/orgs/${orgId}/meetings`, { from: query.from, to: query.to, roomId: query.roomId || undefined, includeCancelled: query.includeCancelled ? 'true' : undefined })).data,
    placeholderData: keepPreviousData, refetchInterval: MEETINGS_REFRESH_MS, refetchIntervalInBackground: false,
  });
}

export function useMeeting(id: string | null) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.detail(orgId, MEETINGS, id ?? ''),
    queryFn: async () => (await api.get<Envelope<MeetingDetailDto>>(`/orgs/${orgId}/meetings/${id}`)).data,
    enabled: !!id, refetchInterval: MEETINGS_REFRESH_MS, refetchIntervalInBackground: false,
  });
}

export function useMeetingMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  // a booking or a cancellation changes the room's "meetings today" and the meeting-in-progress of its entries
  const invalidate = () => { for (const e of [MEETINGS, ROOMS, ACCESS_EVENTS]) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const create = useMutation({ mutationFn: async (input: MeetingInput) => (await api.post<Envelope<MeetingDetailDto>>(`/orgs/${orgId}/meetings`, input)).data, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: async (id: string) => (await api.post<Envelope<MeetingDetailDto>>(`/orgs/${orgId}/meetings/${id}/cancel`, {})).data, onSuccess: invalidate });
  return { create, cancel };
}

export interface AccessLogQuery { from: string; to: string; roomId?: string | undefined; unauthorizedOnly?: boolean | undefined; page: number; pageSize: number }
export function useAccessEvents(query: AccessLogQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, ACCESS_EVENTS, query),
    queryFn: () => api.get<PageEnvelope<AccessEventDto>>(`/orgs/${orgId}/access-events`, { ...query, roomId: query.roomId || undefined, unauthorizedOnly: query.unauthorizedOnly ? 'true' : undefined }),
    placeholderData: keepPreviousData, enabled,
  });
}
