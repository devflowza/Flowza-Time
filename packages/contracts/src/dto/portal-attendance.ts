import { z } from 'zod';
import { booleanQuerySchema, isoDateSchema, isoDateTimeSchema, paginationQuerySchema, timeSchema, uuidSchema } from '../common.js';
import {
  ATTENDANCE_NOTE_CATEGORIES, ATTENDANCE_NOTE_STATUSES, GEOFENCE_ENFORCEMENTS, GEOFENCE_SCOPES, NOTE_REVIEW_DECISIONS, REGULARISATION_STATUSES, REGULARISATION_TYPES,
  SELF_PUNCH_CHANNELS, SELF_PUNCH_DIRECTIONS, SELFIE_CHECKIN_STATUSES, SHIFT_SWAP_STATUSES,
  type ApprovalRequestStatus, type AttendanceFlag, type AttendanceNoteCategory, type AttendanceNoteStatus, type AttendanceStatus, type GeofenceEnforcement, type GeofenceScope,
  type GeofenceVerdict, type RegularisationStatus, type RegularisationType, type SelfieCheckinStatus, type SelfPunchChannel, type SelfPunchDirection, type ShiftSwapStatus,
} from '../enums.js';
import type { AttendanceSettings } from '../organizations.js';
import { updateSchemaOf } from '../dto-features/devices.js';

// Employee portal attendance (HR portal Prompt 4): check-in / check-out with geofence verdicts, selfie check-ins, per-day
// reasons (notes), regularisation requests, the shift tab + swaps and self statistics — plus the manager / HR surfaces that
// review them (notes, selfies, grants, geofences). Every /orgs/:orgId/me/… endpoint acts on the caller's own employee
// record (the membership's employee link) and never accepts an employee id.

const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);
/** GPS accuracy radius in metres as the device reports it (0 = unknown precision is not accepted: omit it instead). */
const accuracySchema = z.number().positive().max(100_000);

// ----- geofence evaluation ------------------------------------------------------------------------------------------------------

/** Result of one geofence evaluation (domain `evaluateGeofence`). */
export interface GeofenceVerdictDto {
  verdict: GeofenceVerdict;
  /** Why (e.g. `no_fences_assigned`, `geofence_off`, `outside`, `gps_accuracy_too_low`, `location_missing`, `mock_location`). */
  reason: string;
  /** The fence that decided the verdict (the worst one), or the nearest when allowed / no fence applies. */
  geofenceId: string | null;
  geofenceName: string | null;
  /** Distance from the fence's edge (0 inside); null without a location. */
  distanceM: number | null;
  scope: GeofenceScope | null;
  enforcement: GeofenceEnforcement | null;
}
/** A fence the employee's punches are judged against (for the check-in page's "nearest zone" preview). */
export interface SelfGeofenceDto { id: string; name: string; latitude: number; longitude: number; radiusM: number; hasPolygon: boolean; enforcement: GeofenceEnforcement; scope: GeofenceScope }

// ----- self-service punch -----------------------------------------------------------------------------------------------------------

export const selfPunchPreviewSchema = z.object({
  direction: z.enum(SELF_PUNCH_DIRECTIONS).default('in'),
  channel: z.enum(SELF_PUNCH_CHANNELS).default('web'),
  lat: latitudeSchema.optional(),
  lng: longitudeSchema.optional(),
  accuracy: accuracySchema.optional(),
  isMock: z.boolean().optional(),
}).refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'lat and lng go together', path: ['lng'] });
export type SelfPunchPreviewInput = z.infer<typeof selfPunchPreviewSchema>;

/**
 * POST /orgs/:orgId/me/punch. The punch time is ALWAYS the server's clock: `clientQueuedAt` (when an offline punch was
 * queued on the device) is stored in the raw payload for information only. `idempotencyKey` makes a replay (the offline
 * queue re-sending, a double click) return the original punch instead of recording a second one.
 */
export const selfPunchSchema = z.object({
  direction: z.enum(SELF_PUNCH_DIRECTIONS),
  channel: z.enum(SELF_PUNCH_CHANNELS).default('web'),
  lat: latitudeSchema.optional(),
  lng: longitudeSchema.optional(),
  accuracy: accuracySchema.optional(),
  isMock: z.boolean().optional(),
  clientQueuedAt: isoDateTimeSchema.optional(),
  idempotencyKey: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'Letters, digits and _ . : - only'),
}).refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'lat and lng go together', path: ['lng'] });
export type SelfPunchInput = z.infer<typeof selfPunchSchema>;

/** GET /orgs/:orgId/me/punch/status — `channel` decides which switch (web / mobile check-in) the blockers are computed for. */
export const selfPunchStatusQuerySchema = z.object({ channel: z.enum(SELF_PUNCH_CHANNELS).default('web') });

/** One punch of today as the check-in page shows it (raw ledger: self-service and terminal punches alike). */
export interface SelfPunchDto { id: string; punchedAt: string; direction: string; source: string; channel: SelfPunchChannel | null; verdict: GeofenceVerdict | null; deviceName: string | null; processingStatus: string }

/** Why a self-service punch was refused (details.reason of the 403 / 409). */
export const SELF_PUNCH_REFUSALS = ['WEB_CHECKIN_DISABLED', 'MOBILE_CHECKIN_DISABLED', 'IP_NOT_ALLOWED', 'OUT_OF_WINDOW', 'OUTSIDE_GEOFENCE', 'MOCK_LOCATION', 'SELFIE_REQUIRED', 'DUPLICATE_PUNCH', 'ALREADY_CHECKED_IN', 'NOT_CHECKED_IN', 'PERIOD_LOCKED', 'NOT_ACTIVE',
  /** The employee's attendance policy (`policy.methods`, Enterprise) does not allow this channel (web / mobile / selfie). */
  'CHECKIN_METHOD_NOT_ALLOWED'] as const;
export type SelfPunchRefusal = (typeof SELF_PUNCH_REFUSALS)[number];

export interface SelfPunchStatusDto {
  date: string;
  timezone: string;
  serverTime: string;
  punches: SelfPunchDto[];
  /** Today's computed record, once the engine has run. */
  today: {
    status: AttendanceStatus; flags: AttendanceFlag[]; firstInAt: string | null; lastOutAt: string | null; workedMinutes: number;
    /**
     * When the employee may check out: the shift end, or — on a flexible shift — the check-in + the required minutes (+ unpaid
     * breaks). Absent from an API older than the flexible check-out (engine 1.1.0); null when no shift applies.
     */
    expectedEndAt?: string | null;
    /** Minutes the employee is expected to work today (0 on a day off). */
    scheduledMinutes?: number;
  } | null;
  /** 'in' after a check-in, 'out' after a check-out, null before the first punch (or when the last punch's direction is unknown). */
  lastDirection: SelfPunchDirection | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  /** Reasons a punch would be refused before any location is known (disabled channels, IP outside the allow-list, selfie required). */
  blockers: SelfPunchRefusal[];
  policy: Pick<AttendanceSettings['selfService'], 'webCheckIn' | 'mobileCheckIn' | 'requireGeofence' | 'allowSelfieCheckIn' | 'checkInWindow' | 'checkOutWindow' | 'outOfWindowAction' | 'duplicatePunchSeconds'> & { ipRestricted: boolean };
  grant: { openAttendance: boolean; selfieRequired: boolean };
  /** Whether the selfie check-in is available to the caller (organisation switch + grant). */
  selfieAvailable: boolean;
  fences: SelfGeofenceDto[];
  /**
   * The shift that applies to the employee on `date`, resolved live from the assignments (the resolver of the shift tab and
   * the engine: assignment, rotation pattern or the organisation's default shift) — what the check-in page names, even before
   * today's record exists. Absent from an older API.
   */
  shift?: SelfShiftTodayDto;
  /**
   * A temporary deployment to another branch covering today (Enterprise, advanced_scheduling): the check-in also accepts that
   * branch's geofences. Null when none; absent from an older API.
   */
  deployment?: { branchId: string; branchName: string | null; toDate: string } | null;
}

/** The shift of one day as the check-in page shows it (the shift tab's day without the swap). */
export type SelfShiftTodayDto = Omit<SelfShiftDayDto, 'swap'>;

export interface SelfPunchPreviewDto {
  verdict: GeofenceVerdictDto;
  outOfWindow: boolean;
  /** What would refuse the punch right now (empty = it would be recorded). */
  refusals: SelfPunchRefusal[];
  wouldBeFlagged: boolean;
}

export interface SelfPunchResultDto {
  /** true when this call replayed an earlier punch with the same idempotency key (nothing new was recorded). */
  replayed: boolean;
  punch: SelfPunchDto;
  verdict: GeofenceVerdictDto;
  outOfWindow: boolean;
  flagged: boolean;
}

// ----- selfie check-in ------------------------------------------------------------------------------------------------------------

export const SELFIE_MAX_BYTES = 2 * 1024 * 1024;
/** POST /orgs/:orgId/me/selfie-checkin as JSON (the multipart form carries the same fields plus a `photo` file). */
export const selfSelfieSchema = z.object({
  direction: z.enum(SELF_PUNCH_DIRECTIONS),
  /** JPEG / PNG / WebP, base64 or a data URL; at most 2 MB once decoded. */
  imageBase64: z.string().min(16).max(Math.ceil((SELFIE_MAX_BYTES * 4) / 3) + 64),
  lat: latitudeSchema.optional(),
  lng: longitudeSchema.optional(),
  accuracy: accuracySchema.optional(),
  isMock: z.boolean().optional(),
}).refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'lat and lng go together', path: ['lng'] });
export type SelfSelfieInput = z.infer<typeof selfSelfieSchema>;
/** The multipart form of the selfie check-in: the `photo` file plus these fields (form values arrive as strings). */
export const selfSelfieFormSchema = z.object({
  direction: z.enum(SELF_PUNCH_DIRECTIONS),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  accuracy: z.coerce.number().positive().max(100_000).optional(),
  isMock: booleanQuerySchema.optional(),
}).refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'lat and lng go together', path: ['lng'] });

export interface SelfieCheckinDto {
  id: string; employeeId: string; employeeName: string | null; employeeNumber: string | null; punchedAt: string; direction: SelfPunchDirection;
  latitude: number | null; longitude: number | null; accuracyM: number | null; verdict: GeofenceVerdict | null; status: SelfieCheckinStatus;
  reviewedBy: string | null; reviewedByName: string | null; reviewedAt: string | null; reviewReason: string | null; rawTransactionId: string | null; createdAt: string;
  /** True when the caller reviews it as the employee's line manager (false = organisation-wide oversight). */
  viaManager?: boolean;
  /** The caller may approve / reject it (line manager, or attendance.approve in scope); absent on the employee's own list. */
  canReview?: boolean;
  /**
   * The caller may open the photo (a 60-second signed URL from the API — the only way to the object): the employee, their
   * line managers, attendance reviewers in scope. Absent from an API that predates the flag (treat as true).
   */
  canViewPhoto?: boolean;
}
export const selfieListQuerySchema = paginationQuerySchema.extend({ status: z.enum(SELFIE_CHECKIN_STATUSES).optional(), employeeId: uuidSchema.optional() });
export const selfieReviewSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(1000).optional() })
  .refine((v) => v.decision !== 'reject' || !!v.reason, { message: 'A reason is required when rejecting.', path: ['reason'] });
export type SelfieReviewInput = z.infer<typeof selfieReviewSchema>;
/**
 * A selfie photo, served by the API (every issue is audited). Since the Prompt 4 review (P2-17) `url` is a `data:` URL of the
 * type detected from the bytes (the object is re-validated server-side; no storage URL leaves the API); `expiresInSeconds`
 * is how long the client may keep it.
 */
export interface SelfiePhotoDto { url: string; expiresInSeconds: number; contentType?: 'image/jpeg' | 'image/png' | 'image/webp' }

/** Withdrawing one's own regularisation / swap: an optional reason (a default is recorded when none is given). */
export const portalCancelSchema = z.object({ reason: z.string().trim().min(3).max(500).optional() });

// ----- attendance grants ----------------------------------------------------------------------------------------------------------

export const attendanceGrantsInputSchema = z.object({ openAttendance: z.boolean(), selfieRequired: z.boolean() });
export type AttendanceGrantsInput = z.infer<typeof attendanceGrantsInputSchema>;
export interface AttendanceGrantsDto {
  employeeId: string; openAttendance: boolean; selfieRequired: boolean; grantedBy: string | null; grantedByName: string | null; grantedAt: string | null;
  /** The organisation's selfie check-in switch (Settings → Attendance): while it is off "selfie required" asks for nothing. */
  selfieCheckInEnabled: boolean;
}

// ----- attendance notes (per-day reasons) ----------------------------------------------------------------------------------------

export const selfNoteInputSchema = z.object({
  date: isoDateSchema,
  category: z.enum(ATTENDANCE_NOTE_CATEGORIES),
  note: z.string().trim().min(3, 'Explain the day in a few words').max(2000),
});
export type SelfNoteInput = z.infer<typeof selfNoteInputSchema>;
/** PATCH …/me/attendance/notes/:id — no defaults (a single-field edit never resets the other). */
export const selfNoteUpdateSchema = z.object({
  category: z.enum(ATTENDANCE_NOTE_CATEGORIES).optional(),
  note: z.string().trim().min(3).max(2000).optional(),
}).refine((v) => v.category !== undefined || v.note !== undefined, { message: 'Nothing to update' });
export type SelfNoteUpdateInput = z.infer<typeof selfNoteUpdateSchema>;
export const selfNotesQuerySchema = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() });

export const NOTE_LIST_SCOPES = ['mine', 'team', 'all'] as const;
export type NoteListScope = (typeof NOTE_LIST_SCOPES)[number];
export const attendanceNotesQuerySchema = paginationQuerySchema.extend({
  /** mine = my direct reports' notes and notes routed to me by the approval engine; team = my direct reports; all = organisation-wide oversight. */
  scope: z.enum(NOTE_LIST_SCOPES).default('mine'),
  status: z.enum(ATTENDANCE_NOTE_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  employeeId: uuidSchema.optional(),
  /** Only the notes waiting for a review (pending / info requested). */
  open: booleanQuerySchema.optional(),
});
export type AttendanceNotesQuery = z.infer<typeof attendanceNotesQuerySchema>;

/**
 * POST /orgs/:orgId/attendance/notes/:id/review. A rejection names its pay effect; a question needs its text.
 * `onBehalfOfUserId` names the pending seat an organisation-wide reviewer's override (or an escalated reviewer's decision)
 * fills — REQUIRED when the note's approval level is ALL or QUORUM with several seats waiting (the approval request's
 * `abilities.mustChooseSeat`; 400 `APPROVAL_SEAT_CHOICE_MESSAGE` otherwise), exactly as on /approvals/:id/decide (engine §9.8).
 */
export const noteReviewSchema = z.object({
  decision: z.enum(NOTE_REVIEW_DECISIONS),
  reason: z.string().trim().max(1000).optional(),
  payEffectDays: z.union([z.literal(0), z.literal(0.5), z.literal(1)]).optional(),
  onBehalfOfUserId: uuidSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.decision === 'reject' && v.payEffectDays === undefined) ctx.addIssue({ code: 'custom', path: ['payEffectDays'], message: 'Choose the pay effect of the rejection (none, half day, full day).' });
  if (v.decision !== 'reject' && v.payEffectDays !== undefined) ctx.addIssue({ code: 'custom', path: ['payEffectDays'], message: 'Only a rejection has a pay effect.' });
  if (v.decision === 'request_info' && !v.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Write the question for the employee.' });
});
export type NoteReviewInput = z.infer<typeof noteReviewSchema>;

/** What a rejection cost: charged to a paid leave type, loss of pay, or nothing. */
export interface NoteChargeDto { outcome: 'charged_leave' | 'lop' | 'already_charged' | 'covered_by_leave' | 'excused' | 'no_effect' | 'not_applicable'; payEffectDays: number; leaveTypeCode: string | null }

export interface AttendanceNoteDto {
  id: string; employeeId: string; attendanceDate: string; category: AttendanceNoteCategory; note: string; status: AttendanceNoteStatus;
  submittedAt: string; reviewedBy: string | null; reviewedByName: string | null; reviewedAt: string | null; reviewReason: string | null; reviewVia: 'manager' | 'oversight' | null;
  infoRequestMessage: string | null; infoRequestedAt: string | null; payEffectDays: number | null; lossOfPay: boolean;
  deductedLeaveTypeCode: string | null; deductedLeaveTypeName: string | null; approvalRequestId: string | null;
  approvalStatus: ApprovalRequestStatus | null; approvalCurrentStep: number | null; approvalStepCount: number | null;
  excusedAt: string | null; createdAt: string; updatedAt: string;
}
/** A note in the manager / HR review list. */
export interface AttendanceNoteReviewItemDto extends AttendanceNoteDto {
  employeeName: string; employeeNumber: string; branchId: string | null; branchName: string | null;
  /** The engine's verdict on the day (null before the day was computed). */
  dayStatus: AttendanceStatus | null; dayFlags: AttendanceFlag[];
  firstInAt: string | null; lastOutAt: string | null; timezone: string | null;
  /** Days of this employee excused in the note's calendar year (the badge next to the name). */
  excusedCountYear: number;
  /** True when the caller sees the note through organisation-wide oversight rather than as the employee's line manager. */
  isOversight: boolean;
  /** Whether the caller may review it now (pending / info requested, not their own, entitled). */
  canReview: boolean;
}
export interface NoteReviewResultDto { note: AttendanceNoteDto; requestStatus: ApprovalRequestStatus | null; terminal: boolean; charge: NoteChargeDto | null }

// ----- regularisation ---------------------------------------------------------------------------------------------------------------

/** POST /orgs/:orgId/me/regularisations. Proposed times are instants (UTC); missed / wrong punch need at least one of them. */
export const selfRegularisationInputSchema = z.object({
  date: isoDateSchema,
  type: z.enum(REGULARISATION_TYPES),
  proposedInAt: isoDateTimeSchema.optional(),
  proposedOutAt: isoDateTimeSchema.optional(),
  reason: z.string().trim().min(3, 'Explain the request in a few words').max(1000),
}).superRefine((v, ctx) => {
  if ((v.type === 'missed_punch' || v.type === 'wrong_punch') && !v.proposedInAt && !v.proposedOutAt) ctx.addIssue({ code: 'custom', path: ['proposedInAt'], message: 'Give the check-in and / or check-out time.' });
  if (v.proposedInAt && v.proposedOutAt && Date.parse(v.proposedOutAt) <= Date.parse(v.proposedInAt)) ctx.addIssue({ code: 'custom', path: ['proposedOutAt'], message: 'The check-out must be after the check-in.' });
});
export type SelfRegularisationInput = z.infer<typeof selfRegularisationInputSchema>;
export const selfRegularisationsQuerySchema = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional(), status: z.enum(REGULARISATION_STATUSES).optional() });
export interface RegularisationDto {
  id: string; employeeId: string; attendanceDate: string; type: RegularisationType; proposedInAt: string | null; proposedOutAt: string | null; reason: string;
  status: RegularisationStatus; approvalRequestId: string | null; approvalStatus: ApprovalRequestStatus | null; approvalCurrentStep: number | null; approvalStepCount: number | null;
  appliedCorrectionId: string | null; appliedAt: string | null; decidedByName: string | null; decidedAt: string | null; decisionNote: string | null; createdAt: string; updatedAt: string;
}

// ----- shift tab + swaps ------------------------------------------------------------------------------------------------------------

export interface SelfShiftSummaryDto {
  id: string; code: string; name: string; type: 'FIXED' | 'FLEXIBLE'; startTime: string | null; endTime: string | null; requiredMinutes: number | null;
  graceInMinutes: number | null; crossesMidnight: boolean; color: string | null; breakMinutes: number;
}
export interface SelfShiftDayDto {
  date: string;
  shift: SelfShiftSummaryDto | null;
  /** How the shift was obtained: an assignment, a rotation pattern, the organisation's default shift, or nothing. */
  source: 'ASSIGNMENT' | 'PATTERN' | 'DEFAULT' | 'NONE';
  /** Weekly off (employee / branch / organisation) or a rotation pattern off day. */
  isOff: boolean;
  holidayName: string | null;
  onLeave: boolean;
  /** A swap covers this date (pending or approved). */
  swap: { id: string; status: ShiftSwapStatus; withEmployeeName: string | null } | null;
}
export interface SelfShiftAssignmentDto { id: string; targetType: 'ORGANIZATION' | 'BRANCH' | 'DEPARTMENT' | 'TEAM' | 'EMPLOYEE'; shiftName: string | null; patternName: string | null; effectiveFrom: string; effectiveTo: string | null; isSwap: boolean }
export interface SelfShiftDto { date: string; timezone: string; today: SelfShiftDayDto; upcoming: SelfShiftDayDto[]; history: SelfShiftAssignmentDto[] }

export const selfShiftSwapInputSchema = z.object({
  date: isoDateSchema,
  withEmployeeId: uuidSchema,
  reason: z.string().trim().min(3, 'Explain the swap in a few words').max(1000),
});
export type SelfShiftSwapInput = z.infer<typeof selfShiftSwapInputSchema>;
export const swapCandidatesQuerySchema = z.object({ date: isoDateSchema, search: z.string().trim().max(100).optional() });
export interface SwapCandidateDto { employeeId: string; displayName: string; employeeNumber: string; shift: SelfShiftSummaryDto | null; isOff: boolean; eligible: boolean }
export interface ShiftSwapDto {
  id: string; swapDate: string; status: ShiftSwapStatus; reason: string;
  requesterEmployeeId: string; requesterName: string | null; targetEmployeeId: string; targetName: string | null;
  requesterShift: { id: string; name: string; code: string } | null; targetShift: { id: string; name: string; code: string } | null;
  /** Whether the caller filed it (false = the caller is the colleague it names). */
  mine: boolean;
  approvalRequestId: string | null; approvalStatus: ApprovalRequestStatus | null; decidedAt: string | null; decisionNote: string | null; createdAt: string;
}
export const selfShiftSwapsQuerySchema = z.object({ status: z.enum(SHIFT_SWAP_STATUSES).optional() });

// ----- self statistics --------------------------------------------------------------------------------------------------------------

export const SELF_STATS_RANGES = ['30d', 'month', 'year'] as const;
export const selfStatsQuerySchema = z.object({ range: z.enum(SELF_STATS_RANGES).default('30d') });
export type SelfStatsHintKind = 'low_attendance' | 'short_hours' | 'late_days' | 'absent_days' | 'missing_checkouts';
export interface SelfStatsHintDto { kind: SelfStatsHintKind; value: number; target: number | null }
export interface PunctualityWindowDto { from: string; to: string; days: number; onTimeDays: number; lateDays: number; avgArrivalDeltaMinutes: number | null; totalDelayMinutes: number; avgDelayMinutes: number | null }
export interface SelfStatsDto {
  range: (typeof SELF_STATS_RANGES)[number]; from: string; to: string;
  /**
   * `workingDays` / `attendancePct` follow the ONE portal definition shared with the month card (HR portal Prompt 4 review,
   * P2-14; `attendanceRateOf` in @flowza/domain): expected = present, half-day, absent and missing-punch days, approved leave
   * outside (a half-day-leave day counts 0.5); attended = present and missing-punch days in full, half days by half.
   * `missingCheckouts` never counts today's running day (its check-out is still to come).
   */
  workingDays: number; presentDays: number; halfDays: number; absentDays: number; leaveDays: number; lateDays: number; missingCheckouts: number;
  workedDays: number; workedMinutes: number;
  /** Average hours per day over the days with worked time; null without any. */
  avgHoursPerDay: number | null;
  /** Attended / expected days × 100 (see above), one decimal; null before the first working day. */
  attendancePct: number | null;
  targets: { attendancePct: number; fullDayHours: number };
  hints: SelfStatsHintDto[];
  punctuality: { last7Days: PunctualityWindowDto; thisMonth: PunctualityWindowDto; lastMonth: PunctualityWindowDto };
}

// ----- geofences (HR) ---------------------------------------------------------------------------------------------------------------

/** A weekly window in the branch's local time: ISO weekdays (1 = Monday … 7 = Sunday); may wrap midnight. */
export const geofenceTimeWindowSchema = z.object({ days: z.array(z.number().int().min(1).max(7)).min(1).max(7), start: timeSchema, end: timeSchema });
export type GeofenceTimeWindow = z.infer<typeof geofenceTimeWindowSchema>;
const polygonSchema = z.array(z.tuple([latitudeSchema, longitudeSchema])).min(3).max(100);
export const geofenceAssignmentInputSchema = z.object({
  scope: z.enum(GEOFENCE_SCOPES),
  targetId: uuidSchema.nullable().optional(),
  priority: z.number().int().min(0).max(1000).default(100),
  requireOnCheckIn: z.boolean().default(true),
  requireOnCheckOut: z.boolean().default(true),
}).superRefine((v, ctx) => {
  if (v.scope === 'org' && v.targetId) ctx.addIssue({ code: 'custom', path: ['targetId'], message: 'An organisation-wide assignment has no target.' });
  if (v.scope !== 'org' && !v.targetId) ctx.addIssue({ code: 'custom', path: ['targetId'], message: 'Choose who the fence applies to.' });
  if (!v.requireOnCheckIn && !v.requireOnCheckOut) ctx.addIssue({ code: 'custom', path: ['requireOnCheckIn'], message: 'The fence must apply to check-ins, check-outs or both.' });
});
export type GeofenceAssignmentInput = z.infer<typeof geofenceAssignmentInputSchema>;
const geofenceShape = {
  name: z.string().trim().min(1).max(120),
  branchId: uuidSchema.nullable().optional(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  radiusM: z.number().int().min(30).max(5000),
  polygon: polygonSchema.nullable().optional(),
  enforcement: z.enum(GEOFENCE_ENFORCEMENTS).default('soft_warn'),
  accuracyThresholdM: z.number().int().min(5).max(5000).default(100),
  graceM: z.number().int().min(0).max(1000).default(0),
  activeFrom: isoDateSchema.nullable().optional(),
  activeTo: isoDateSchema.nullable().optional(),
  timeWindows: z.array(geofenceTimeWindowSchema).max(14).nullable().optional(),
  isActive: z.boolean().default(true),
};
export const geofenceInputSchema = z.object({ ...geofenceShape, assignments: z.array(geofenceAssignmentInputSchema).max(200).optional() })
  .refine((v) => !v.activeFrom || !v.activeTo || v.activeTo >= v.activeFrom, { message: 'activeTo must be on/after activeFrom', path: ['activeTo'] });
export type GeofenceInput = z.infer<typeof geofenceInputSchema>;
/** PUT /orgs/:orgId/geofences/:id/assignments — replaces the fence's whole assignment list. */
export const geofenceAssignmentsInputSchema = z.object({ assignments: z.array(geofenceAssignmentInputSchema).max(200) });
/** PATCH body: no defaults (AGENTS.md Zod 4 pitfall — a rename must not reset enforcement / accuracy / grace / isActive). */
export const geofenceUpdateSchema = updateSchemaOf<Omit<GeofenceInput, 'assignments'>>(geofenceShape);
export type GeofenceUpdateInput = Partial<Omit<GeofenceInput, 'assignments'>>;
export interface GeofenceAssignmentDto { id: string; geofenceId: string; scope: GeofenceScope; targetId: string | null; targetName: string | null; priority: number; requireOnCheckIn: boolean; requireOnCheckOut: boolean; createdAt: string }
/**
 * A geofence as HR sees it. Which fence judges a punch (ATT-63/64, the pack's decision): the MOST SPECIFIC assignment scope
 * that applies to the employee wins (employee, then team, then department, then branch, then organisation), and within that
 * scope the WORST verdict of its fences decides (one failing fence fails the punch; priority only orders equally specific
 * fences for display).
 */
export interface GeofenceDto {
  id: string; organizationId: string; branchId: string | null; branchName: string | null; name: string; latitude: number; longitude: number; radiusM: number;
  polygon: Array<[number, number]> | null; enforcement: GeofenceEnforcement; accuracyThresholdM: number; graceM: number; activeFrom: string | null; activeTo: string | null;
  timeWindows: GeofenceTimeWindow[]; isActive: boolean; assignments: GeofenceAssignmentDto[]; createdAt: string; updatedAt: string;
  /**
   * The caller may change or delete this fence and its assignments (HR portal Prompt 4 review, P0-1): the fence belongs to one
   * of their branches (organisation-wide fences only for an unrestricted holder) AND every assignment it carries targets people
   * inside their scope. Absent from an API that predates the flag (treat as true for `attendance.manage_geofences`).
   */
  editable?: boolean;
  /** How many of the fence's assignments target people outside the caller's scope (they are not listed and not editable). */
  hiddenAssignments?: number;
}
export const geofenceListQuerySchema = z.object({ branchId: uuidSchema.optional(), includeInactive: booleanQuerySchema.optional() });
export const geofenceEvaluateSchema = z.object({
  employeeId: uuidSchema,
  lat: latitudeSchema.optional(),
  lng: longitudeSchema.optional(),
  accuracy: accuracySchema.optional(),
  isMock: z.boolean().optional(),
  direction: z.enum(SELF_PUNCH_DIRECTIONS).default('in'),
  /** Evaluate at this instant (default now) — time windows and active dates use the employee's branch timezone. */
  at: isoDateTimeSchema.optional(),
}).refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'lat and lng go together', path: ['lng'] });
export type GeofenceEvaluateInput = z.infer<typeof geofenceEvaluateSchema>;
export interface GeofenceEvaluationDto {
  verdict: GeofenceVerdictDto;
  requireGeofence: 'off' | 'flag' | 'block';
  winningScope: GeofenceScope | null;
  /** Every fence considered (the winning scope's first), with its own outcome. */
  fences: Array<{ id: string; name: string; scope: GeofenceScope; priority: number; considered: boolean; applicable: boolean; inactiveReason: string | null; distanceM: number | null; outcome: GeofenceVerdict | null }>;
}
