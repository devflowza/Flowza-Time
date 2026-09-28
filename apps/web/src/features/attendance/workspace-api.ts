import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AttendanceCalendarRowDto, AttendancePreviewDto, AttendancePreviewInput, AttendanceRecordEditInput, AttendanceRecordEditResultDto, AttendanceSummaryExportDto, AttendanceSummaryFigures,
  AttendanceSummaryRowDto, AttendanceTimelineDto, BulkAttendanceStatusInput, BulkStatusResultDto, ManualStatusDto, UnmatchedActionResultDto, UnmatchedAssignInput, UnmatchedIgnoreInput,
  UnmatchedPunchGroupDto, UnmatchedRestoreInput,
} from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

/** HR attendance workspace (HR portal Prompt 6a): calendar, record edit + preview, bulk status, timeline, summary, triage. */
export type Query = Record<string, string | number | boolean | undefined>;
export type CalendarPage = PageEnvelope<AttendanceCalendarRowDto> & { meta: { month?: string; days?: string[]; today?: string } };
export type SummaryPage = PageEnvelope<AttendanceSummaryRowDto> & { meta: { month?: string; from?: string; to?: string; totals?: AttendanceSummaryFigures } };

const WORKSPACE_ENTITIES = ['attendance-daily', 'attendance-monthly', 'attendance-records', 'attendance-events', 'attendance-activity', 'attendance-calendar', 'attendance-summary', 'attendance-manual', 'attendance-timeline'];

export function useInvalidateWorkspace() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => { for (const e of WORKSPACE_ENTITIES) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) }); };
}

export function useAttendanceCalendar(query: Query, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-calendar', query), queryFn: () => api.get<CalendarPage>(`/orgs/${orgId}/attendance/calendar`, query), placeholderData: keepPreviousData, enabled, staleTime: 15_000 });
}

/** Days whose status is a manual override (applied SET_STATUS) in a range → the `Manual` chip of the register. */
export function useManualStatuses(params: { from: string; to: string; branchId?: string; employeeId?: string }, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'attendance-manual', params),
    queryFn: async () => (await api.get<Envelope<ManualStatusDto[]>>(`/orgs/${orgId}/attendance/manual-statuses`, params)).data,
    enabled, staleTime: 15_000,
  });
}

export function useAttendanceSummary(query: Query, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-summary', query), queryFn: () => api.get<SummaryPage>(`/orgs/${orgId}/attendance/summary`, query), placeholderData: keepPreviousData, enabled, staleTime: 30_000 });
}

export function useAttendanceTimeline(params: { employeeId: string; date: string } | null) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'attendance-timeline', params ?? {}),
    queryFn: async () => (await api.get<Envelope<AttendanceTimelineDto>>(`/orgs/${orgId}/attendance/timeline`, params ?? undefined)).data,
    enabled: !!params,
  });
}

/** Policy preview of a day (runs the engine on the real inputs; writes nothing). */
export function useRecordPreview(input: AttendancePreviewInput | null) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: qk.list(orgId, 'attendance-preview', input ?? {}),
    queryFn: async () => (await api.post<Envelope<AttendancePreviewDto>>(`/orgs/${orgId}/attendance/preview`, input)).data,
    enabled: !!input, retry: false, placeholderData: keepPreviousData, staleTime: 5_000,
  });
}

export function useUnmatchedPunches(query: Query, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'attendance-unmatched', query), queryFn: () => api.get<PageEnvelope<UnmatchedPunchGroupDto>>(`/orgs/${orgId}/attendance/unmatched`, query), placeholderData: keepPreviousData, enabled });
}

export function useWorkspaceMutations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const invalidate = useInvalidateWorkspace();
  const invalidateTriage = () => { void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'attendance-unmatched') }); void qc.invalidateQueries({ queryKey: qk.entity(orgId, 'attendance-raw') }); };
  const editRecord = useMutation({
    mutationFn: async (input: AttendanceRecordEditInput) => (await api.post<Envelope<AttendanceRecordEditResultDto>>(`/orgs/${orgId}/attendance/record-edits`, input, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: invalidate,
  });
  const bulkStatus = useMutation({
    mutationFn: async (input: BulkAttendanceStatusInput) => (await api.post<Envelope<BulkStatusResultDto>>(`/orgs/${orgId}/attendance/bulk-status`, input, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: invalidate,
  });
  const exportSummary = useMutation({ mutationFn: async (query: Query) => (await api.get<Envelope<AttendanceSummaryExportDto>>(`/orgs/${orgId}/attendance/summary/export`, query)).data });
  const assign = useMutation({ mutationFn: async (input: UnmatchedAssignInput) => (await api.post<Envelope<UnmatchedActionResultDto>>(`/orgs/${orgId}/attendance/unmatched/assign`, input)).data, onSuccess: invalidateTriage });
  const ignore = useMutation({ mutationFn: async (input: UnmatchedIgnoreInput) => (await api.post<Envelope<UnmatchedActionResultDto>>(`/orgs/${orgId}/attendance/unmatched/ignore`, input)).data, onSuccess: invalidateTriage });
  const restore = useMutation({ mutationFn: async (input: UnmatchedRestoreInput) => (await api.post<Envelope<UnmatchedActionResultDto>>(`/orgs/${orgId}/attendance/unmatched/restore`, input)).data, onSuccess: invalidateTriage });
  return { editRecord, bulkStatus, exportSummary, assign, ignore, restore };
}

/** Save a text export (CSV built by the API) as a file. */
export function saveTextFile(file: { fileName: string; contentType: string; content: string }) {
  const blob = new Blob([file.content], { type: `${file.contentType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = file.fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
