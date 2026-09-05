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

export const SYNC_JOB_TYPES = ['PULL_ATTENDANCE', 'PULL_EMPLOYEES', 'PUSH_EMPLOYEE', 'PUSH_EMPLOYEES', 'DEVICE_HEALTH_CHECK', 'RECONCILIATION', 'TEST_CONNECTION', 'DELETE_EMPLOYEE', 'RESTART_DEVICE'] as const;
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

export const RAW_SOURCES = ['POLL', 'WEBHOOK', 'DEVICE_PUSH', 'IMPORT', 'MANUAL'] as const;
export type RawSource = (typeof RAW_SOURCES)[number];

export const EVENT_SOURCES = ['DEVICE', 'MANUAL', 'CORRECTION', 'IMPORT', 'MOBILE'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const ATTENDANCE_EVENT_TYPES = ['PUNCH', 'PUNCH_IN', 'PUNCH_OUT', 'BREAK_START', 'BREAK_END'] as const;
export type AttendanceEventType = (typeof ATTENDANCE_EVENT_TYPES)[number];

export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'HALF_DAY', 'MISSING_PUNCH', 'NOT_JOINED', 'EXITED', 'PENDING'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_FLAGS = ['LATE', 'EARLY_DEPARTURE', 'OVERTIME', 'MISSING_IN', 'MISSING_OUT', 'MANUAL_CORRECTION', 'OUT_OF_WINDOW', 'WORKED_ON_HOLIDAY', 'WORKED_ON_WEEKLY_OFF', 'HALF_DAY_LEAVE', 'DUPLICATE_PUNCHES_COLLAPSED', 'RAMADAN_HOURS', 'CROSS_MIDNIGHT', 'NO_SHIFT', 'UNDER_HOURS'] as const;
export type AttendanceFlag = (typeof ATTENDANCE_FLAGS)[number];

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

export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const HALF_DAY_PARTS = ['FIRST_HALF', 'SECOND_HALF'] as const;
export type HalfDayPart = (typeof HALF_DAY_PARTS)[number];

export const CORRECTION_TYPES = ['ADD_PUNCH', 'EDIT_PUNCH', 'REMOVE_PUNCH', 'SET_STATUS'] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

export const CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'APPLIED'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const APPROVAL_ENTITIES = ['ATTENDANCE_CORRECTION', 'OVERTIME', 'MISSING_PUNCH', 'SHIFT_CHANGE', 'MANUAL_ATTENDANCE', 'LEAVE'] as const;
export type ApprovalEntity = (typeof APPROVAL_ENTITIES)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVER_TYPES = ['MANAGER', 'ROLE', 'USER'] as const;
export type ApproverType = (typeof APPROVER_TYPES)[number];

export const REPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TYPES = ['daily_attendance', 'monthly_attendance', 'employee_attendance', 'branch_attendance', 'department_attendance', 'late_report', 'absence_report', 'overtime_report', 'missing_punch_report', 'device_sync_report', 'device_health_report', 'audit_report', 'payroll_summary'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const IMPORT_STATUSES = ['UPLOADED', 'VALIDATING', 'VALIDATED', 'IMPORTING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const NOTIFICATION_CATEGORIES = ['DEVICE', 'ATTENDANCE', 'APPROVAL', 'SYSTEM', 'SUBSCRIPTION'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'dead', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Queue names used by the worker; each has its own concurrency budget. */
export const QUEUE_NAMES = ['sync', 'processing', 'reports', 'notifications', 'maintenance'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
