export type { PayrollPeriodDto } from '@flowza/contracts';

export interface PayrollSummaryDto {
  id: string; employeeId: string; employeeNumber: string; employeeName: string; departmentId: string | null; branchId: string | null; branchName: string | null; periodStart: string; periodEnd: string; status: string; version: number;
  workingDays: number; presentDays: number | null; absentDays: number | null; leaveDays: number | null; paidLeaveDays: number | null; holidayDays: number; weeklyOffDays: number; halfDays: number; lateDays: number; lateMinutes: number; earlyDepartureMinutes: number; missingPunchDays: number;
  regularMinutes: number; overtimeMinutes: number; overtimeWeeklyOffMinutes: number; overtimeHolidayMinutes: number; recordVersions: Record<string, unknown> | null; computedAt: string; finalizedAt: string | null; finalizedBy: string | null;
}
export interface PayrollJobAccepted { jobId: string; status: 'QUEUED'; message: string }
