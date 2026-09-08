import type { ReportType } from '@flowza/contracts';
import { dailyAttendance } from './daily.js';
import { employeeDirectory } from './employee-directory.js';
import type { ReportDefinition } from './types.js';

/**
 * Generators by report type. A key present here must be `status: 'available'` in REPORT_TYPE_DEFINITIONS and vice
 * versa — `reports.test.ts` asserts the two lists agree, so a type can never be offered without a generator again.
 */
export const REPORT_DEFINITIONS: Partial<Record<ReportType, ReportDefinition>> = {
  daily_attendance: dailyAttendance,
  employee_directory: employeeDirectory,
};

export type { ReportDefinition } from './types.js';
