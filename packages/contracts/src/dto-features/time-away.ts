import { z } from 'zod';
import { isoDateSchema, isoDateTimeSchema, uuidSchema } from '../common.js';
import { TIME_AWAY_KINDS, TIME_AWAY_STATUSES, type ApprovalRequestStatus, type TimeAwayKind, type TimeAwaySource, type TimeAwayStatus } from '../enums.js';
import type { AttendanceAwayIntervalDto } from '../attendance.js';

/**
 * Time away inside the working day (docs/time-away.md): an employee leaves the site during the shift and comes back — OFFICIAL
 * duty (client visit, government office) or PERSONAL permission. Filed ahead of time from the portal, or when stepping out
 * (a break-out punch on the self-service device + a request for the expected window). Decided through the approval engine
 * (entity TIME_AWAY); the engine classifies the measured away time against the APPROVED windows.
 */

const reasonSchema = z.string().trim().min(3).max(500);
const destinationSchema = z.string().trim().min(1).max(200);

/** POST /orgs/:orgId/me/time-away — a planned window (instants, UTC) on one working day. */
export const timeAwayRequestInputSchema = z.object({
  kind: z.enum(TIME_AWAY_KINDS),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  reason: reasonSchema,
  destination: destinationSchema.optional(),
}).refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), { path: ['endsAt'], message: 'Must be after the start' });
export type TimeAwayRequestInput = z.infer<typeof timeAwayRequestInputSchema>;

/** POST /orgs/:orgId/me/time-away/step-out — leaving now; `expectedBackAt` closes the requested window. */
export const timeAwayStepOutInputSchema = z.object({
  kind: z.enum(TIME_AWAY_KINDS),
  expectedBackAt: isoDateTimeSchema,
  reason: reasonSchema,
  destination: destinationSchema.optional(),
  channel: z.enum(['web', 'mobile']).default('web'),
  /** Replay guard of the client (the same key returns the first result). */
  idempotencyKey: z.string().trim().min(8).max(100),
});
export type TimeAwayStepOutInput = z.infer<typeof timeAwayStepOutInputSchema>;

/** POST /orgs/:orgId/me/time-away/back — "I'm back" (only when the policy's `returnBy` allows the portal). */
export const timeAwayBackInputSchema = z.object({
  channel: z.enum(['web', 'mobile']).default('web'),
  idempotencyKey: z.string().trim().min(8).max(100),
});
export type TimeAwayBackInput = z.infer<typeof timeAwayBackInputSchema>;

export const timeAwayCancelInputSchema = z.object({ reason: z.string().trim().min(3).max(500).optional() });

export const myTimeAwayQuerySchema = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional(), status: z.enum(TIME_AWAY_STATUSES).optional() });
/** GET /orgs/:orgId/time-away — HR (attendance.view, branch scope) or a line manager's team. */
export const timeAwayListQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  status: z.enum(TIME_AWAY_STATUSES).optional(),
  kind: z.enum(TIME_AWAY_KINDS).optional(),
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  /** The employees of this department (as the monthly totals' department filter). */
  departmentId: uuidSchema.optional(),
  scope: z.enum(['all', 'team']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type TimeAwayListQuery = z.infer<typeof timeAwayListQuerySchema>;

export interface TimeAwayRequestDto {
  id: string;
  employeeId: string;
  employeeName?: string | null;
  employeeNumber?: string | null;
  branchId: string | null;
  attendanceDate: string;
  kind: TimeAwayKind;
  source: TimeAwaySource;
  startsAt: string;
  endsAt: string;
  returnedAt: string | null;
  minutes: number;
  reason: string;
  destination: string | null;
  status: TimeAwayStatus;
  approvalRequestId: string | null;
  approvalStatus: ApprovalRequestStatus | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

/** The time-away policy as the portal needs it (resolved for today), with this month's personal permission use. */
export interface TimeAwayPolicyDto {
  enabled: boolean;
  stepOutFromPortal: boolean;
  returnBy: 'device' | 'device_or_portal';
  officialCountsAsWorked: boolean;
  personalMonthlyQuotaMinutes: number | null;
  personalMaxMinutes: number | null;
  /** Approved + pending personal minutes of the current calendar month. */
  personalUsedMinutes: number;
  /** Why the policy measures nothing today, e.g. the punch interpretation keeps only the first and the last punch. */
  inactiveReason: 'DISABLED' | 'FIRST_LAST_INTERPRETATION' | null;
}

/** GET /orgs/:orgId/me/time-away/status — what the portal shows on the check-in page. */
export interface TimeAwayStatusDto {
  date: string;
  timezone: string;
  serverTime: string;
  policy: TimeAwayPolicyDto;
  /** The open step-out (stepped out, not back yet), if any. */
  away: { requestId: string; kind: TimeAwayKind; since: string; expectedBackAt: string; reason: string; destination: string | null; status: TimeAwayStatus } | null;
  /** On site now (checked in and not stepped out). */
  onSite: boolean;
  canStepOut: boolean;
  canComeBack: boolean;
  /** Today's classified away intervals so far (from the last computed record). */
  intervals: AttendanceAwayIntervalDto[];
  /** Today's requests (any status). */
  requests: TimeAwayRequestDto[];
}

/** Monthly time-away totals of one employee (HR report). */
export interface TimeAwaySummaryRowDto {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  departmentName: string | null;
  days: number;
  awayMinutes: number;
  officialDutyMinutes: number;
  permissionMinutes: number;
  unapprovedAwayMinutes: number;
  /** Days flagged UNAPPROVED_AWAY. */
  unapprovedDays: number;
  pendingRequests: number;
}
export const timeAwaySummaryQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  scope: z.enum(['all', 'team']).default('all'),
});
export type TimeAwaySummaryQuery = z.infer<typeof timeAwaySummaryQuerySchema>;
