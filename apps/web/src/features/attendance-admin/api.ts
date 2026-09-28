import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CsvExportFileDto, NotesReportRowDto, NotesReportTotalsDto, RegularisationAdminDecision, RegularisationAdminItemDto, RegularisationBulkResultDto, RegularisationDecisionResultDto, ShiftRosterDto,
} from '@flowza/contracts';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCan, useOrgId } from '@/features/me/use-me';
import { invalidateApprovalViews } from '@/features/approvals/api';

/** Query-key entities of the HR attendance administration pages (HR portal Prompt 6b). */
export const REGULARISATIONS = 'attendance-regularisations';
export const NOTES_REPORT = 'attendance-notes-report';

export type AdminQuery = Record<string, string | number | boolean | undefined>;

/** Who reaches the regularisation register (the API re-checks, RLS scopes the rows to the caller's branches). */
export function useRegularisationAccess() {
  const can = useCan();
  return { page: can('attendance.approve') || can('attendance.review_notes'), exportCsv: can('report.export') };
}

export function useRegularisationsAdmin(query: AdminQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, REGULARISATIONS, query), queryFn: () => api.get<PageEnvelope<RegularisationAdminItemDto>>(`/orgs/${orgId}/attendance/regularisations`, query), placeholderData: keepPreviousData, enabled });
}

/** A decision moves the register, the approval views (inbox, /me, dashboard), the employee's portal and the attendance days. */
function useInvalidateRegularisations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => {
    for (const e of [REGULARISATIONS, NOTES_REPORT]) void qc.invalidateQueries({ queryKey: qk.entity(orgId, e) });
    invalidateApprovalViews(qc, orgId);
  };
}

export function useRegularisationDecisions() {
  const orgId = useOrgId();
  const invalidate = useInvalidateRegularisations();
  const decide = useMutation({
    mutationFn: async ({ id, decision, comment, stepNo }: { id: string; decision: RegularisationAdminDecision; comment?: string; stepNo?: number }) =>
      (await api.post<Envelope<RegularisationDecisionResultDto>>(`/orgs/${orgId}/attendance/regularisations/${id}/decide`, { decision, comment: comment || undefined, stepNo }, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: invalidate,
  });
  /** Each item is decided on its own through the engine; the answer reports one line per item. */
  const bulkDecide = useMutation({
    mutationFn: async ({ items, decision, comment }: { items: Array<{ id: string; stepNo?: number }>; decision: RegularisationAdminDecision; comment?: string }) =>
      (await api.post<Envelope<RegularisationBulkResultDto>>(`/orgs/${orgId}/attendance/regularisations/bulk-decide`, { items, decision, comment: comment || undefined }, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: invalidate,
  });
  return { decide, bulkDecide };
}

/** The register as CSV (report.export; built, escaped and audited by the API). */
export async function fetchRegularisationsCsv(orgId: string, query: AdminQuery): Promise<CsvExportFileDto> {
  return (await api.get<Envelope<CsvExportFileDto>>(`/orgs/${orgId}/attendance/regularisations/export`, query)).data;
}

export interface NotesReportPage { data: NotesReportRowDto[]; meta: { page: number; pageSize: number; total: number; totalPages: number; totals: NotesReportTotalsDto } }
export function useNotesReport(query: AdminQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, NOTES_REPORT, query), queryFn: () => api.get<NotesReportPage>(`/orgs/${orgId}/attendance/notes/report`, query), placeholderData: keepPreviousData, enabled });
}
export async function fetchNotesReportCsv(orgId: string, query: AdminQuery): Promise<CsvExportFileDto> {
  return (await api.get<Envelope<CsvExportFileDto>>(`/orgs/${orgId}/attendance/notes/report/export`, query)).data;
}

/** The monthly shift roster (Finance ATT-105): one page of employees, the engine's shift per day. shift.view. */
export interface RosterPage { data: ShiftRosterDto; meta: { page: number; pageSize: number; total: number; totalPages: number } }
export function useShiftRoster(query: AdminQuery, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'shift-roster', query), queryFn: () => api.get<RosterPage>(`/orgs/${orgId}/shift-roster`, query), placeholderData: keepPreviousData, enabled });
}
