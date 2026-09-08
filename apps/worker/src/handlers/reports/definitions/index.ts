import type { ReportType } from '@flowza/contracts';
import { dailyAttendance } from './daily.js';
import { absenceReport, lateReport } from './day-lists.js';
import { employeeAttendance } from './detail.js';
import { employeeDirectory } from './employee-directory.js';
import { missingPunchReport } from './missed-punch.js';
import { monthlyAttendance } from './monthly.js';
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
  employee_directory: employeeDirectory,
};

export type { ReportDefinition } from './types.js';
