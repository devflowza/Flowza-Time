/**
 * Closed enumerations shared by the database (Postgres enums), API and UI.
 * Keep in sync with supabase/migrations. `as const` tuples make them usable in Zod and as TS unions.
 */
export const ORG_STATUSES = ['trial', 'active', 'suspended', 'closed'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const RECORD_STATUSES = ['active', 'inactive', 'archived'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const GENDERS = ['male', 'female', 'other', 'unspecified'] as const;
export type Gender = (typeof GENDERS)[number];

export const EMPLOYMENT_STATUSES = ['active', 'on_leave', 'suspended', 'terminated', 'resigned'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'temporary'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const IDENTITY_DOCUMENT_TYPES = ['civil_id', 'passport', 'labour_card', 'residence_card', 'visa', 'other'] as const;
export type IdentityDocumentType = (typeof IDENTITY_DOCUMENT_TYPES)[number];

export const INTEGRATION_TYPES = ['VENDOR_CLOUD_PULL', 'VENDOR_WEBHOOK', 'DEVICE_PUSH', 'ON_PREM_SERVER_API', 'LAN'] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const PROVIDER_STATUSES = ['available', 'beta', 'placeholder', 'deprecated'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const VERIFICATION_STATUSES = ['VERIFIED', 'REPORTED', 'UNVERIFIED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const DEVICE_STATUSES = ['active', 'disabled', 'decommissioned'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const CONNECTION_STATUSES = ['unknown', 'online', 'offline', 'degraded', 'error', 'vendor_degraded'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const DEVICE_EMPLOYEE_SYNC_STATUSES = ['PENDING', 'IN_SYNC', 'OUT_OF_SYNC', 'FAILED', 'OFFLINE', 'UNSUPPORTED', 'REMOVING', 'REMOVED'] as const;
export type DeviceEmployeeSyncStatus = (typeof DEVICE_EMPLOYEE_SYNC_STATUSES)[number];

export const SYNC_JOB_TYPES = ['PULL_ATTENDANCE', 'PULL_EMPLOYEES', 'PUSH_EMPLOYEE', 'PUSH_EMPLOYEES', 'DEVICE_HEALTH_CHECK', 'RECONCILIATION', 'TEST_CONNECTION', 'DELETE_EMPLOYEE', 'RESTART_DEVICE', 'PUSH_ATTENDANCE'] as const;
export type SyncJobType = (typeof SYNC_JOB_TYPES)[number];

export const SYNC_TRIGGERS = ['MANUAL', 'SCHEDULED', 'WEBHOOK', 'SYSTEM', 'DEVICE_PUSH'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_STATUSES = ['PENDING', 'QUEUED', 'RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'RETRYING', 'CANCELLED'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const SYNC_ITEM_STATUSES = ['PENDING', 'QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'RETRYING', 'OFFLINE', 'UNSUPPORTED', 'CANCELLED', 'SKIPPED'] as const;
export type SyncItemStatus = (typeof SYNC_ITEM_STATUSES)[number];

export const VERIFICATION_METHODS = ['fingerprint', 'face', 'card', 'pin', 'password', 'palm', 'iris', 'mobile', 'manual', 'unknown'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const PUNCH_DIRECTIONS = ['in', 'out', 'break_out', 'break_in', 'overtime_in', 'overtime_out', 'unknown'] as const;
export type PunchDirection = (typeof PUNCH_DIRECTIONS)[number];

/** SELF_SERVICE = web / mobile check-ins and approved selfie check-ins of the employee portal (virtual device `self_service`). */
export const RAW_SOURCES = ['POLL', 'WEBHOOK', 'DEVICE_PUSH', 'IMPORT', 'MANUAL', 'SELF_SERVICE'] as const;
export type RawSource = (typeof RAW_SOURCES)[number];

export const EVENT_SOURCES = ['DEVICE', 'MANUAL', 'CORRECTION', 'IMPORT', 'MOBILE'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const ATTENDANCE_EVENT_TYPES = ['PUNCH', 'PUNCH_IN', 'PUNCH_OUT', 'BREAK_START', 'BREAK_END'] as const;
export type AttendanceEventType = (typeof ATTENDANCE_EVENT_TYPES)[number];

export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'HALF_DAY', 'MISSING_PUNCH', 'NOT_JOINED', 'EXITED', 'PENDING'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/**
 * Daily-record flags in their canonical (serialisation) order — the engine emits them in this order so equal results
 * always compare equal. New flags are appended, never inserted, so stored records keep their order. The policy-parity
 * flags (HR portal Prompt 3): UNEXCUSED / EXCUSED / LOP / PAY_EFFECT_* come from `attendance_day_marks`; OUTSIDE_GEOFENCE /
 * SELF_SERVICE_PUNCH come from the punch payload; NON_WORKING_DAY_WORK marks work recorded on a weekly off / holiday.
 */
export const ATTENDANCE_FLAGS = ['LATE', 'EARLY_DEPARTURE', 'OVERTIME', 'MISSING_IN', 'MISSING_OUT', 'MANUAL_CORRECTION', 'OUT_OF_WINDOW', 'WORKED_ON_HOLIDAY', 'WORKED_ON_WEEKLY_OFF', 'HALF_DAY_LEAVE', 'DUPLICATE_PUNCHES_COLLAPSED', 'RAMADAN_HOURS', 'CROSS_MIDNIGHT', 'NO_SHIFT', 'UNDER_HOURS',
  'UNEXCUSED', 'EXCUSED', 'LOP', 'PAY_EFFECT_HALF', 'PAY_EFFECT_FULL', 'OUTSIDE_GEOFENCE', 'SELF_SERVICE_PUNCH', 'NON_WORKING_DAY_WORK',
  // engine 1.4.0 (Enterprise): arrival beyond the policy's very-late threshold; a day worked on two shifts (double shift)
  'VERY_LATE', 'DOUBLE_SHIFT'] as const;
export type AttendanceFlag = (typeof ATTENDANCE_FLAGS)[number];

/** Kinds of `attendance_day_marks` rows: a reviewed verdict on one employee-day (HR portal Prompt 3). */
export const DAY_MARK_KINDS = ['UNEXCUSED', 'EXCUSED', 'LOP', 'PAY_EFFECT'] as const;
export type DayMarkKind = (typeof DAY_MARK_KINDS)[number];
/** Who wrote a day mark: the day-close sweep, a note review (Prompt 4), HR by hand, or another system flow. */
export const DAY_MARK_SOURCES = ['SWEEP', 'NOTE_REVIEW', 'HR', 'SYSTEM'] as const;
export type DayMarkSource = (typeof DAY_MARK_SOURCES)[number];
/** Pay effect of an unexcused day in days: none, half or a full day. */
export const PAY_EFFECT_DAYS = [0, 0.5, 1] as const;
export type PayEffectDays = (typeof PAY_EFFECT_DAYS)[number];

export const SHIFT_TYPES = ['FIXED', 'FLEXIBLE'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];

export const ASSIGNMENT_TARGETS = ['ORGANIZATION', 'BRANCH', 'DEPARTMENT', 'TEAM', 'EMPLOYEE'] as const;
export type AssignmentTarget = (typeof ASSIGNMENT_TARGETS)[number];

export const PUNCH_INTERPRETATIONS = ['FIRST_LAST', 'PAIRED', 'DIRECTIONAL'] as const;
export type PunchInterpretation = (typeof PUNCH_INTERPRETATIONS)[number];

export const ROUNDING_MODES = ['NONE', 'NEAREST', 'UP', 'DOWN'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export const MISSING_PUNCH_BEHAVIORS = ['FLAG_ONLY', 'ASSUME_SHIFT_END', 'TREAT_AS_ABSENT', 'TREAT_AS_HALF_DAY'] as const;
export type MissingPunchBehavior = (typeof MISSING_PUNCH_BEHAVIORS)[number];

export const HOLIDAY_TYPES = ['PUBLIC', 'RELIGIOUS', 'COMPANY', 'REGIONAL'] as const;
export type HolidayType = (typeof HOLIDAY_TYPES)[number];

/** INFO_REQUESTED (leave v2): an approver asked the employee for more information; the reply puts it back to PENDING. */
export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'INFO_REQUESTED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
/** Leave statuses that hold dates (overlap protection) and count as pending in balances (all but APPROVED). */
export const LEAVE_ACTIVE_STATUSES = ['PENDING', 'APPROVED', 'INFO_REQUESTED'] as const satisfies readonly LeaveStatus[];
export const LEAVE_UNDECIDED_STATUSES = ['PENDING', 'INFO_REQUESTED'] as const satisfies readonly LeaveStatus[];

/** Leave v2 type policy vocabularies (mirrored by CHECK constraints in migration 20260928000700). */
export const LEAVE_COUNT_MODES = ['working', 'calendar'] as const;
export type LeaveCountModeValue = (typeof LEAVE_COUNT_MODES)[number];
export const LEAVE_ACCRUALS = ['none', 'monthly'] as const;
export type LeaveAccrualValue = (typeof LEAVE_ACCRUALS)[number];
export const LEAVE_APPLICABLE_GENDERS = ['all', 'male', 'female'] as const;
export type LeaveApplicableGenderValue = (typeof LEAVE_APPLICABLE_GENDERS)[number];
export const LEAVE_COMMENT_KINDS = ['comment', 'info_request', 'reply', 'system'] as const;
export type LeaveCommentKind = (typeof LEAVE_COMMENT_KINDS)[number];
/** Comp-off credit lifecycle; `cancelled` = the employee withdrew the request before a decision. */
export const COMP_OFF_STATUSES = ['pending_approval', 'approved', 'rejected', 'used', 'partially_used', 'expired', 'cancelled'] as const;
export type CompOffStatus = (typeof COMP_OFF_STATUSES)[number];
export const COMP_OFF_WORKED_ON_TYPES = ['weekly_off', 'holiday'] as const;
export type CompOffWorkedOnType = (typeof COMP_OFF_WORKED_ON_TYPES)[number];

export const HALF_DAY_PARTS = ['FIRST_HALF', 'SECOND_HALF'] as const;
export type HalfDayPart = (typeof HALF_DAY_PARTS)[number];

export const CORRECTION_TYPES = ['ADD_PUNCH', 'EDIT_PUNCH', 'REMOVE_PUNCH', 'SET_STATUS'] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

export const CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'APPLIED'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const APPROVAL_ENTITIES = ['ATTENDANCE_CORRECTION', 'OVERTIME', 'MISSING_PUNCH', 'SHIFT_CHANGE', 'MANUAL_ATTENDANCE', 'LEAVE', 'ATTENDANCE_NOTE', 'SHIFT_SWAP', 'COMP_OFF', 'REGULARISATION', 'OVERTIME_CLAIM'] as const;
export type ApprovalEntity = (typeof APPROVAL_ENTITIES)[number];

/** Status of a request, a step or an actor row. Requests never carry SKIPPED (a step/actor that never got to decide). */
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'INVALIDATED', 'SKIPPED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
/** Request-level statuses (the History view lists everything but PENDING). */
export const APPROVAL_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'INVALIDATED'] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export const APPROVER_TYPES = ['MANAGER', 'SECONDARY_MANAGER', 'MANAGER_CHAIN', 'HR_ADMIN', 'DEPARTMENT_HEAD', 'BRANCH_MANAGER', 'ROLE', 'USER'] as const;
export type ApproverType = (typeof APPROVER_TYPES)[number];

/** How a level with several eligible approvers is satisfied: one of them (ANY), every one (ALL) or `requiredCount` of them (QUORUM). */
export const APPROVAL_STEP_MODES = ['ANY', 'ALL', 'QUORUM'] as const;
export type ApprovalStepMode = (typeof APPROVAL_STEP_MODES)[number];
/** Where an overdue level escalates to: the next level's approvers join the current level, or the HR admins / owners do. */
export const APPROVAL_ESCALATION_TARGETS = ['NEXT_STEP', 'HR_ADMIN', 'OWNER'] as const;
export type ApprovalEscalationTarget = (typeof APPROVAL_ESCALATION_TARGETS)[number];
export const APPROVAL_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
/** Inbox scope: my queue (assignee or delegate), my direct reports' requests, or the whole organisation (org-wide keys). */
export const APPROVAL_INBOX_SCOPES = ['mine', 'team', 'all'] as const;
export type ApprovalInboxScope = (typeof APPROVAL_INBOX_SCOPES)[number];

export const REPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TYPES = ['daily_attendance', 'monthly_attendance', 'employee_attendance', 'branch_attendance', 'department_attendance', 'late_report', 'absence_report', 'overtime_report', 'missing_punch_report', 'device_sync_report', 'device_health_report', 'audit_report', 'payroll_summary', 'employee_directory', 'leave_report', 'attendance_summary', 'weekly_attendance', 'weekly_in_out', 'monthly_summary', 'monthly_detail', 'monthly_timesheet'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const IMPORT_STATUSES = ['UPLOADED', 'VALIDATING', 'VALIDATED', 'IMPORTING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * Notification categories (Postgres enum `notification_category`, values appended, never reordered). LEAVE and REPORTS were
 * added by HR portal Prompt 8 (migration 20260928001000): user preferences are kept per (organisation, category, channel).
 */
export const NOTIFICATION_CATEGORIES = ['DEVICE', 'ATTENDANCE', 'APPROVAL', 'SYSTEM', 'SUBSCRIPTION', 'LEAVE', 'REPORTS'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
/** The channels a notification is delivered on today (SMS / WhatsApp / push are declared in the enum, not delivered). */
export const NOTIFICATION_DELIVERY_CHANNELS = ['IN_APP', 'EMAIL'] as const satisfies readonly NotificationChannel[];
export type NotificationDeliveryChannel = (typeof NOTIFICATION_DELIVERY_CHANNELS)[number];
/** Languages notifications are written in (recipient's profile locale, else the organisation's, else English). */
export const NOTIFICATION_LOCALES = ['en', 'ar'] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'dead', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Queue names used by the worker; each has its own concurrency budget. */
export const QUEUE_NAMES = ['sync', 'processing', 'reports', 'notifications', 'maintenance'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
/**
 * RUN_REPORT_SCHEDULE (a share, a schedule's run, "Run now") only resolves recipients and queues one GENERATE_REPORT per copy —
 * database work, no renderer — so it runs on the general worker's `processing` queue. Only GENERATE_REPORT needs the Chromium
 * reports machine (`reports`); tying the fan-out to that machine too made every share wait on (and die with) its deploy.
 */
export const REPORT_DELIVERY_QUEUE: QueueName = 'processing';

// ----- employee portal attendance (HR portal Prompt 4) -----------------------------------------------------------------------

/** Provider key of the per-organisation virtual device that owns self-service punches (never listed with the terminals). */
export const SELF_SERVICE_PROVIDER_KEY = 'self_service';
/** What an employee's reason for a day is about. */
export const ATTENDANCE_NOTE_CATEGORIES = ['client_visit', 'field_work', 'late_reason', 'absence_reason', 'wfh', 'other'] as const;
export type AttendanceNoteCategory = (typeof ATTENDANCE_NOTE_CATEGORIES)[number];
/** Note lifecycle: pending → approved | rejected | excused | info_requested (→ pending again when the employee answers). */
export const ATTENDANCE_NOTE_STATUSES = ['pending', 'approved', 'rejected', 'excused', 'info_requested'] as const;
export type AttendanceNoteStatus = (typeof ATTENDANCE_NOTE_STATUSES)[number];
/** What a reviewer does with a note. */
export const NOTE_REVIEW_DECISIONS = ['approve', 'reject', 'excuse', 'request_info'] as const;
export type NoteReviewDecision = (typeof NOTE_REVIEW_DECISIONS)[number];
export const REGULARISATION_TYPES = ['missed_punch', 'wrong_punch', 'wfh_unmarked', 'system_downtime'] as const;
export type RegularisationType = (typeof REGULARISATION_TYPES)[number];
export const REGULARISATION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type RegularisationStatus = (typeof REGULARISATION_STATUSES)[number];
export const SELFIE_CHECKIN_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type SelfieCheckinStatus = (typeof SELFIE_CHECKIN_STATUSES)[number];
export const SHIFT_SWAP_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
/** Shift change requests (Enterprise, shift_requests): work another shift (CHANGE) or a second shift (ADDITIONAL) over a range. */
export const SHIFT_CHANGE_KINDS = ['CHANGE', 'ADDITIONAL'] as const;
export type ShiftChangeKind = (typeof SHIFT_CHANGE_KINDS)[number];
export const SHIFT_CHANGE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ShiftChangeStatus = (typeof SHIFT_CHANGE_STATUSES)[number];
export type ShiftSwapStatus = (typeof SHIFT_SWAP_STATUSES)[number];
/** Per-fence enforcement when a punch is outside it (capped by `attendance.selfService.requireGeofence`). */
export const GEOFENCE_ENFORCEMENTS = ['hard_block', 'soft_warn', 'advisory_log'] as const;
export type GeofenceEnforcement = (typeof GEOFENCE_ENFORCEMENTS)[number];
/** Who a fence applies to; the most specific scope that has an applicable fence wins (employee > team > department > branch > org). */
export const GEOFENCE_SCOPES = ['org', 'branch', 'department', 'team', 'employee'] as const;
export type GeofenceScope = (typeof GEOFENCE_SCOPES)[number];
/** Outcome of a geofence evaluation: no fence applies, inside, outside (flagged / logged), refused (outside or mock location). */
export const GEOFENCE_VERDICTS = ['no_fence', 'allowed', 'flagged', 'logged', 'denied_outside', 'denied_mock'] as const;
export type GeofenceVerdict = (typeof GEOFENCE_VERDICTS)[number];
/** Self-service punch channel (web browser or the mobile app); each has its own switch in the attendance settings. */
export const SELF_PUNCH_CHANNELS = ['web', 'mobile'] as const;
export type SelfPunchChannel = (typeof SELF_PUNCH_CHANNELS)[number];
export const SELF_PUNCH_DIRECTIONS = ['in', 'out'] as const;
export type SelfPunchDirection = (typeof SELF_PUNCH_DIRECTIONS)[number];
