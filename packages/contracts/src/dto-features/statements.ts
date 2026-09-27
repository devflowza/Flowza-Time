import { z } from 'zod';
import { STATEMENT_STATUSES, type StatementFinalizedReason, type StatementStatus } from '../enums.js';
import { booleanQuerySchema, isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';

/**
 * Monthly attendance statements (docs/statements.md). The snapshot is the document the employee signs: built once by
 * the worker from the daily records, stored on the statement row, immutable afterwards (DB trigger). It carries both
 * raw minutes/instants (integrity, exports) and the display strings rendered with the organisation's own notation,
 * clock and date format at build time, so the public review page shows exactly what was signed with no locale or
 * timezone arithmetic in the browser.
 */

export const STATEMENT_SNAPSHOT_VERSION = 1;

export const statementSnapshotDaySchema = z.object({
  date: isoDateSchema,
  /** Localised display date + weekday, prebuilt (e.g. "01/11/2026" / "Sun"). */
  dateLabel: z.string(),
  weekdayLabel: z.string(),
  status: z.string(),
  /** Printed attendance code after tenant overrides; leave days carry the leave type's own code. */
  code: z.string(),
  leave: z.object({ code: z.string(), name: z.string(), nameAr: z.string().nullable(), isPaid: z.boolean() }).nullable(),
  firstInAt: z.string().nullable(),
  lastOutAt: z.string().nullable(),
  /** Clock strings in the organisation's time format ("08:39" / "8:39 am"); dash when there was no punch. */
  signIn: z.string(),
  signOut: z.string(),
  workedMinutes: z.number().int().min(0),
  scheduledMinutes: z.number().int().min(0),
  lateMinutes: z.number().int().min(0),
  earlyDepartureMinutes: z.number().int().min(0),
  overtimeMinutes: z.number().int().min(0),
  workedLabel: z.string(),
  flags: z.array(z.string()),
  /** The employee may comment on this day (product rule: sign-in/out discrepancies; padding days outside employment are closed). */
  commentable: z.boolean(),
});
export type StatementSnapshotDay = z.infer<typeof statementSnapshotDaySchema>;

export const statementLeaveTotalSchema = z.object({
  code: z.string(),
  name: z.string(),
  nameAr: z.string().nullable(),
  isPaid: z.boolean(),
  days: z.number(),
});
export type StatementLeaveTotal = z.infer<typeof statementLeaveTotalSchema>;

export const statementTotalsSchema = z.object({
  /** Required working time: the sum of scheduled minutes over the month's working days. */
  requiredMinutes: z.number().int().min(0),
  workedMinutes: z.number().int().min(0),
  /** worked − required; negative when short. */
  differenceMinutes: z.number().int(),
  /** Total delay: late arrival minutes summed over the month. */
  delayMinutes: z.number().int().min(0),
  lateDays: z.number().int().min(0),
  earlyDepartureMinutes: z.number().int().min(0),
  overtimeMinutes: z.number().int().min(0),
  workingDays: z.number().int().min(0),
  presentDays: z.number(),
  absentDays: z.number(),
  halfDays: z.number().int().min(0),
  holidayDays: z.number().int().min(0),
  weeklyOffDays: z.number().int().min(0),
  missingPunchDays: z.number().int().min(0),
  leaveDays: z.number(),
  /** Comp-off, sick, casual, … — every leave type taken this month with the days counted. */
  leaveByType: z.array(statementLeaveTotalSchema),
  requiredLabel: z.string(),
  workedLabel: z.string(),
  /** Signed display difference, e.g. "-4.30" in h.mm notation. */
  differenceLabel: z.string(),
  delayLabel: z.string(),
  overtimeLabel: z.string(),
});
export type StatementTotals = z.infer<typeof statementTotalsSchema>;

export const statementSnapshotSchema = z.object({
  version: z.literal(STATEMENT_SNAPSHOT_VERSION),
  organization: z.object({
    name: z.string(),
    timezone: z.string(),
    locale: z.enum(['en', 'ar']),
    hoursNotation: z.enum(['h.mm', 'hh:mm']),
    timeFormat: z.enum(['12h', '24h']),
  }),
  period: z.object({ start: isoDateSchema, end: isoDateSchema, label: z.string() }),
  employee: z.object({
    id: uuidSchema,
    name: z.string(),
    employeeNumber: z.string(),
    branchName: z.string().nullable(),
    departmentName: z.string().nullable(),
    designationName: z.string().nullable(),
  }),
  days: z.array(statementSnapshotDaySchema).min(1).max(31),
  totals: statementTotalsSchema,
  generatedAt: z.string(),
});
export type StatementSnapshot = z.infer<typeof statementSnapshotSchema>;

/* ── Admin API ─────────────────────────────────────────────────────────────────────────────────────────────────── */

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM');

/** POST /orgs/:orgId/statements/issue — one month back to two years, never the running month (records still moving). */
export const issueStatementsSchema = z.object({
  month: monthSchema,
  employeeIds: z.array(uuidSchema).min(1).max(5000).optional(),
});
export type IssueStatementsInput = z.infer<typeof issueStatementsSchema>;

export const statementListQuerySchema = paginationQuerySchema.extend({
  month: monthSchema.optional(),
  status: z.enum(STATEMENT_STATUSES).optional(),
  employeeId: uuidSchema.optional(),
  /** true → only statements waiting on the caller as approver (the manager inbox). */
  inbox: booleanQuerySchema.optional(),
});
export type StatementListQuery = z.infer<typeof statementListQuerySchema>;

export const approveStatementSchema = z.object({ note: z.string().trim().max(1000).optional() });
export const voidStatementSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export interface StatementListItemDto {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  branchId: string;
  periodStart: string;
  periodEnd: string;
  status: StatementStatus;
  emailTo: string | null;
  emailSentAt: string | null;
  emailError: string | null;
  issuedAt: string;
  firstViewedAt: string | null;
  submittedAt: string | null;
  signedName: string | null;
  commentCount: number;
  approverUserId: string | null;
  approverName: string | null;
  approvedAt: string | null;
  finalizedAt: string | null;
  finalizedReason: StatementFinalizedReason | null;
}

export interface StatementCommentDto {
  id: string;
  attendanceDate: string;
  comment: string;
  createdAt: string;
}

export interface StatementDetailDto extends StatementListItemDto {
  snapshot: StatementSnapshot;
  comments: StatementCommentDto[];
  approvalNote: string | null;
  approvedByName: string | null;
  voidReason: string | null;
  tokenExpiresAt: string;
}

/** 202 body for POST /orgs/:orgId/statements/issue (queue job id — tracked on the Statements page, not /sync). */
export interface StatementsIssueAcceptedDto {
  jobId: string;
  status: 'QUEUED';
  month: string;
}

/* ── Public (tokenized) API ────────────────────────────────────────────────────────────────────────────────────── */

export const publicStatementViewSchema = z.object({ token: z.string().min(20).max(200) });

export const publicStatementSubmitSchema = z.object({
  token: z.string().min(20).max(200),
  /** The typed full name is the digital signature; the API stamps time, IP and user agent alongside it. */
  signedName: z.string().trim().min(2).max(120),
  comments: z
    .array(z.object({ date: isoDateSchema, comment: z.string().trim().min(1).max(1000) }))
    .max(31)
    .default([]),
});
export type PublicStatementSubmitInput = z.infer<typeof publicStatementSubmitSchema>;

/** What the tokenized review page sees: the employee's own statement, nothing else about the organisation. */
export interface PublicStatementDto {
  status: StatementStatus;
  periodStart: string;
  periodEnd: string;
  snapshot: StatementSnapshot;
  comments: StatementCommentDto[];
  submittedAt: string | null;
  signedName: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
  finalizedAt: string | null;
  finalizedReason: StatementFinalizedReason | null;
  tokenExpiresAt: string;
}
