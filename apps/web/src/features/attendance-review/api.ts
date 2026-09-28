import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AttendanceGrantsDto, AttendanceGrantsInput, AttendanceNoteReviewItemDto, AttendanceNoteStatus, GeofenceAssignmentInput, GeofenceDto, GeofenceEvaluateInput,
  GeofenceEvaluationDto, GeofenceInput, GeofenceUpdateInput, NoteListScope, NoteReviewInput, NoteReviewResultDto, SelfieCheckinDto, SelfieCheckinStatus, SelfiePhotoDto, SelfieReviewInput,
} from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useActiveMembership, useCan, useOrgId } from '@/features/me/use-me';

/** Query-key entities of the review side of HR portal Prompt 4. */
export const NOTES = 'attendance-notes';
export const SELFIES = 'selfie-checkins';
export const GEOFENCES = 'geofences';
export const GRANTS = 'attendance-grants';

/** A decision moves the note, the approval request behind it, the employee's portal views and the attendance days. */
function useInvalidateReview() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => { for (const e of [NOTES, SELFIES, 'approvals-inbox', 'approval-request', 'approvals-mine', 'self-service', 'attendance-daily', 'attendance-records', 'attendance-monthly']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
}

export interface NotesQuery { scope: NoteListScope; status?: AttendanceNoteStatus | undefined; open?: boolean | undefined; page: number; pageSize: number }
export function useNotesForReview(query: NotesQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, NOTES, query), queryFn: () => api.get<PageEnvelope<AttendanceNoteReviewItemDto>>(`/orgs/${orgId}/attendance/notes`, { ...query, status: query.status || undefined, open: query.open || undefined }), placeholderData: keepPreviousData, refetchInterval: 60_000, enabled });
}
export function useNoteReview() {
  const orgId = useOrgId();
  const invalidate = useInvalidateReview();
  return useMutation({ mutationFn: async ({ id, input }: { id: string; input: NoteReviewInput }) => (await api.post<Envelope<NoteReviewResultDto>>(`/orgs/${orgId}/attendance/notes/${id}/review`, input)).data, onSuccess: invalidate });
}

export function useSelfiesForReview(query: { status?: SelfieCheckinStatus | undefined; page: number; pageSize: number }, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, SELFIES, query), queryFn: () => api.get<PageEnvelope<SelfieCheckinDto>>(`/orgs/${orgId}/attendance/selfie-checkins`, { ...query, status: query.status || undefined }), placeholderData: keepPreviousData, enabled });
}
/** A short-lived signed URL of one selfie (every issue is audited server-side, so it is fetched only on demand). */
export function useSelfiePhoto(id: string | null) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, SELFIES, `${id ?? ''}:photo`), queryFn: async () => (await api.get<Envelope<SelfiePhotoDto>>(`/orgs/${orgId}/attendance/selfie-checkins/${id}/photo`)).data, enabled: !!id, staleTime: 45_000, gcTime: 60_000, retry: false });
}
export function useSelfieReview() {
  const orgId = useOrgId();
  const invalidate = useInvalidateReview();
  return useMutation({ mutationFn: async ({ id, input }: { id: string; input: SelfieReviewInput }) => (await api.post<Envelope<SelfieCheckinDto>>(`/orgs/${orgId}/attendance/selfie-checkins/${id}/review`, input)).data, onSuccess: invalidate });
}

export function useGeofences(includeInactive = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, GEOFENCES, { includeInactive }), queryFn: async () => (await api.get<Envelope<GeofenceDto[]>>(`/orgs/${orgId}/geofences`, { includeInactive })).data });
}
export function useGeofenceMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = () => { for (const e of [GEOFENCES, 'self-service']) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
  const create = useMutation({ mutationFn: async (input: GeofenceInput) => (await api.post<Envelope<GeofenceDto>>(`/orgs/${orgId}/geofences`, input)).data, onSuccess: invalidate });
  const update = useMutation({ mutationFn: async ({ id, input }: { id: string; input: GeofenceUpdateInput }) => (await api.patch<Envelope<GeofenceDto>>(`/orgs/${orgId}/geofences/${id}`, input)).data, onSuccess: invalidate });
  const replaceAssignments = useMutation({ mutationFn: async ({ id, assignments }: { id: string; assignments: GeofenceAssignmentInput[] }) => (await api.put<Envelope<GeofenceDto>>(`/orgs/${orgId}/geofences/${id}/assignments`, { assignments })).data, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<void>(`/orgs/${orgId}/geofences/${id}`), onSuccess: invalidate });
  const evaluate = useMutation({ mutationFn: async (input: GeofenceEvaluateInput) => (await api.post<Envelope<GeofenceEvaluationDto>>(`/orgs/${orgId}/geofences/evaluate`, input)).data });
  return { create, update, replaceAssignments, remove, evaluate };
}

export function useAttendanceGrants(employeeId: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.detail(orgId, GRANTS, employeeId), queryFn: async () => (await api.get<Envelope<AttendanceGrantsDto>>(`/orgs/${orgId}/employees/${employeeId}/attendance-grants`)).data, enabled, retry: false });
}
export function usePutAttendanceGrants(employeeId: string) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AttendanceGrantsInput) => (await api.put<Envelope<AttendanceGrantsDto>>(`/orgs/${orgId}/employees/${employeeId}/attendance-grants`, input)).data,
    onSuccess: (data) => { qc.setQueryData(qk.detail(orgId, GRANTS, employeeId), data); },
  });
}

/**
 * Who reaches the review pages. Reasons: the organisation-wide reviewers (attendance.review_notes or attendance.approve, with
 * attendance.view) and line managers (a team of their own — the engine routes their reports' reasons to them). Geofences:
 * attendance.manage_geofences.
 */
export function useReviewAccess() {
  const can = useCan();
  const m = useActiveMembership();
  const manager = m?.isManager ?? false;
  const oversight = can('attendance.view') && (can('attendance.review_notes') || can('attendance.approve'));
  return {
    notes: oversight || manager || can('attendance.review_notes') || can('attendance.approve'),
    oversight,
    selfies: can('attendance.view') || manager,
    geofences: can('attendance.manage_geofences'),
  };
}
