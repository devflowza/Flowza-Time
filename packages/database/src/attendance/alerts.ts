/**
 * The automatic attendance notices (late arrival, early departure, absence and its excuse-deadline reminder, missing check-in,
 * weekly appreciation): the job types and the ledger kinds the API and the worker share. The ledger `attendance_alerts`
 * (migration 20261019000400) holds one row per (organisation, employee, date, kind) — a notice goes out once.
 */
export const ATTENDANCE_ALERT_KINDS = ['LATE_ARRIVAL', 'EARLY_DEPARTURE', 'ABSENCE', 'ABSENCE_REMINDER', 'MISSING_CHECK_IN', 'APPRECIATION'] as const;
export type AttendanceAlertKind = (typeof ATTENDANCE_ALERT_KINDS)[number];

/** The 15-minute sweep: catch-up of the record alerts, the absence reminders and the missing check-in reminders. */
export const ATTENDANCE_ALERTS_JOB_TYPE = 'ATTENDANCE_ALERTS';
/**
 * The weekly appreciation run. Payload `{}` = every organisation whose configured weekday and hour have come (the scheduler's
 * hourly tick); `{ organizationId, force: true, requestedBy }` = one organisation now, for the last seven days ("Send now").
 */
export const ATTENDANCE_APPRECIATION_JOB_TYPE = 'ATTENDANCE_APPRECIATION';
export const appreciationNowDedupeKey = (organizationId: string): string => `appreciation-now:${organizationId}`;
