import type { ReportType } from '@flowza/contracts';
import { auditReport } from './audit.js';
import { dailyAttendance } from './daily.js';
import { absenceReport, lateReport, leaveReport } from './day-lists.js';
import { employeeAttendance } from './detail.js';
import { employeeDirectory } from './employee-directory.js';
import { missingPunchReport } from './missed-punch.js';
import { monthlyAttendance } from './monthly.js';
import { attendanceSummary } from './summary.js';
import { weeklyAttendance, weeklyInOut } from './weekly.js';
import type { ReportDefinition } from './types.js';

/**
 * Generators by report type. A key present here must be `status: 'available'` in REPORT_TYPE_DEFINITIONS and vice
 * versa — `reports.test.ts` asserts the two lists agree, so a type can never be offered without a generator again.
 */
export const REPORT_DEFINITIONS: Partial<Record<ReportType, ReportDefinition>> = {
  daily_attendance: dailyAttendance,
  employee_attendance: employeeAttendance,
  monthly_attendance: monthlyAttendance,
  absence_report: absenceReport,
  late_report: lateReport,
  missing_punch_report: missingPunchReport,
  leave_report: leaveReport,
  attendance_summary: attendanceSummary,
  weekly_attendance: weeklyAttendance,
  weekly_in_out: weeklyInOut,
  employee_directory: employeeDirectory,
  audit_report: auditReport,
};

export type { ReportDefinition } from './types.js';
