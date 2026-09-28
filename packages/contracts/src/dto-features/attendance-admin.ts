import { z } from 'zod';
import type { RegularisationDto } from '../dto/portal-attendance.js';
import { NOTE_LIST_SCOPES } from '../dto/portal-attendance.js';
import {
  ATTENDANCE_NOTE_CATEGORIES, ATTENDANCE_NOTE_STATUSES, REGULARISATION_STATUSES, REGULARISATION_TYPES,
  type ApprovalRequestStatus, type ApprovalStatus, type ApproverType, type AttendanceFlag, type AttendanceNoteCategory, type AttendanceNoteStatus, type AttendanceStatus,
} from '../enums.js';
import { isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import type { ApprovalDecideVia } from './approvals.js';

/**
 * HR attendance administration (HR portal Prompt 6b): the regularisation register with decisions through the approval
 * engine (single and bulk — never a direct status write), and the comments & approvals report over attendance reasons.
 * CSV exports are gated by report.export, escaped against formula injection and audited with their row count.
 */

/** A CSV file built by the API (UTF-8 with BOM, CRLF lines). */
export interface CsvExportFileDto { fileName: string; contentType: 'text/csv'; content: string; rowCount: number }

const RANGE_MAX_DAYS = 366;
const withinDays = (from: string | undefined, to: string | undefined, max: number) => !from || !to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) <= (max - 1) * 86_400_000;

// ----- regularisation register ---------------------------------------------------------------------------------------------------

const regularisationFilters = {
  status: z.enum(REGULARISATION_STATUSES).optional(),
  type: z.enum(REGULARISATION_TYPES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
};
const orderedRange = (v: { from?: string | undefined; to?: string | undefined }) => !v.from || !v.to || v.to >= v.from;

/** GET /orgs/:orgId/attendance/regularisations — the organisation's regularisation requests (branch scope applies). */
export const regularisationAdminQuerySchema = paginationQuerySchema.extend(regularisationFilters)
  .refine(orderedRange, { message: 'to must be on/after from', path: ['to'] });
export type RegularisationAdminQuery = z.infer<typeof regularisationAdminQuerySchema>;

/** GET …/attendance/regularisations/export — the same filters, every matching row (bounded). */
export const REGULARISATION_EXPORT_MAX_ROWS = 10_000;
export const regularisationExportQuerySchema = z.object(regularisationFilters)
  .refine(orderedRange, { message: 'to must be on/after from', path: ['to'] });
export type RegularisationExportQuery = z.infer<typeof regularisationExportQuerySchema>;

export interface RegularisationApproverDto { userId: string; name: string; decision: ApprovalStatus }
/** The live level of the request behind a regularisation (what the approver column shows). */
export interface RegularisationApprovalDto {
  requestId: string;
  status: ApprovalRequestStatus;
  currentStep: number | null;
  stepCount: number;
  /** Who the current level asks for (manager, HR admin, role …). */
  approverType: ApproverType | null;
  /** Seated approvers of the current level and their decisions. */
  approvers: RegularisationApproverDto[];
  infoRequested: boolean;
  /** The caller may decide the current level (seat, delegation, escalation or organisation-wide override). */
  canDecide: boolean;
  decideVia: ApprovalDecideVia | null;
}
export interface RegularisationAdminItemDto extends RegularisationDto {
  employeeName: string;
  employeeNumber: string;
  branchId: string | null;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  approval: RegularisationApprovalDto | null;
}

export const REGULARISATION_ADMIN_DECISIONS = ['approve', 'reject'] as const;
export type RegularisationAdminDecision = (typeof REGULARISATION_ADMIN_DECISIONS)[number];
const needsComment = (v: { decision: RegularisationAdminDecision; comment?: string | undefined }) => v.decision !== 'reject' || !!v.comment;

/** POST …/attendance/regularisations/:id/decide — decides the current level of the linked request. */
export const regularisationDecideSchema = z.object({
  decision: z.enum(REGULARISATION_ADMIN_DECISIONS),
  comment: z.string().trim().max(1000).optional(),
  /** The level the caller is looking at (an override must name it; absent = the request's current level). */
  stepNo: z.number().int().min(1).max(20).optional(),
}).refine(needsComment, { message: 'A comment is required when rejecting.', path: ['comment'] });
export type RegularisationDecideInput = z.infer<typeof regularisationDecideSchema>;

export const REGULARISATION_BULK_MAX = 100;
/** POST …/attendance/regularisations/bulk-decide — each item decided on its own (per-item authorisation and result). */
export const regularisationBulkDecideSchema = z.object({
  items: z.array(z.object({ id: uuidSchema, stepNo: z.number().int().min(1).max(20).optional() })).min(1).max(REGULARISATION_BULK_MAX),
  decision: z.enum(REGULARISATION_ADMIN_DECISIONS),
  comment: z.string().trim().max(1000).optional(),
}).refine(needsComment, { message: 'A comment is required when rejecting.', path: ['comment'] })
  .refine((v) => new Set(v.items.map((i) => i.id)).size === v.items.length, { message: 'Each request may appear once.', path: ['items'] });
export type RegularisationBulkDecideInput = z.infer<typeof regularisationBulkDecideSchema>;

export interface RegularisationDecisionResultDto {
  id: string;
  ok: boolean;
  /** The regularisation after the decision (null when it could not be read back). */
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | null;
  requestStatus: ApprovalRequestStatus | null;
  /** The request is still pending on a later level. */
  advanced: boolean;
  code?: string;
  message?: string;
}
export interface RegularisationBulkResultDto { results: RegularisationDecisionResultDto[]; succeeded: number; failed: number }

// ----- comments & approvals report --------------------------------------------------------------------------------------------------

const notesReportFilters = {
  /** mine = my direct reports and reasons routed to me; team = my direct reports; all = organisation-wide oversight. */
  scope: z.enum(NOTE_LIST_SCOPES).default('all'),
  from: isoDateSchema,
  to: isoDateSchema,
  status: z.enum(ATTENDANCE_NOTE_STATUSES).optional(),
  category: z.enum(ATTENDANCE_NOTE_CATEGORIES).optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
};
const reportRange = (v: { from: string; to: string }) => v.to >= v.from && withinDays(v.from, v.to, RANGE_MAX_DAYS);

/** GET /orgs/:orgId/attendance/notes/report — one row per reason in [from, to] (at most 366 days). */
export const notesReportQuerySchema = paginationQuerySchema.extend(notesReportFilters)
  .refine(reportRange, { message: `to must be on/after from, at most ${RANGE_MAX_DAYS} days`, path: ['to'] });
export type NotesReportQuery = z.infer<typeof notesReportQuerySchema>;
export const NOTES_REPORT_EXPORT_MAX_ROWS = 20_000;
export const notesReportExportQuerySchema = z.object(notesReportFilters)
  .refine(reportRange, { message: `to must be on/after from, at most ${RANGE_MAX_DAYS} days`, path: ['to'] });
export type NotesReportExportQuery = z.infer<typeof notesReportExportQuerySchema>;

/** What the reason cost the employee: paid leave charged, loss of pay, or nothing. */
export const NOTE_IMPACTS = ['none', 'leave', 'lop', 'excused', 'pending'] as const;
export type NoteImpact = (typeof NOTE_IMPACTS)[number];

export interface NotesReportRowDto {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  branchId: string | null;
  branchName: string | null;
  departmentName: string | null;
  attendanceDate: string;
  dayStatus: AttendanceStatus | null;
  dayFlags: AttendanceFlag[];
  category: AttendanceNoteCategory;
  note: string;
  status: AttendanceNoteStatus;
  approvalStatus: ApprovalRequestStatus | null;
  approvalCurrentStep: number | null;
  approvalStepCount: number | null;
  submittedAt: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewVia: 'manager' | 'oversight' | null;
  reviewReason: string | null;
  payEffectDays: number | null;
  impact: NoteImpact;
  lossOfPay: boolean;
  deductedLeaveTypeCode: string | null;
  deductedLeaveTypeName: string | null;
  deductedLeaveDays: number | null;
  /** Reasons of this employee excused in the row's calendar year. */
  excusedCountYear: number;
  /** Seen through organisation-wide oversight rather than as the employee's line manager. */
  isOversight: boolean;
}
export interface NotesReportTotalsDto { total: number; pending: number; approved: number; rejected: number; excused: number; infoRequested: number; lopDays: number; leaveDays: number }
