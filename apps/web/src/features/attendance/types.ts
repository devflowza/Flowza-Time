import type { AttendanceDailyRecordDto } from '@flowza/contracts';

/** GET /attendance/daily rows carry the joined branch/department names on top of the contract DTO. */
export type DailyRecord = AttendanceDailyRecordDto & { branchName?: string | null; departmentName?: string | null };

// ---- calculation trace (packages/domain CalculationTrace; every field optional so old/partial traces still render) -----
export interface TracePunch { eventId?: string; punchedAt?: string; local?: string; role?: string; note?: string }
export interface TraceStep { step?: string; detail?: string; values?: Record<string, unknown> }
export interface TraceInputs { shiftId?: string | null; shiftType?: string | null; ruleSetId?: string | null; timezone?: string; window?: { start?: string; end?: string } | null; holiday?: string | null; leave?: string | null; weeklyOff?: boolean }
export interface CalculationTrace { engineVersion?: string; inputs?: TraceInputs | null; punches?: TracePunch[] | null; steps?: TraceStep[] | null }

export interface RecordEvent {
  id: string; punchedAt: string; localTime: string | null; eventType: string; source: string; verificationMethod: string | null; deviceId: string | null; deviceName: string | null;
  voidedAt: string | null; voidedByCorrectionId: string | null; correctionId: string | null; note: string | null; rawTransactionId: string | null; attributed: boolean | null;
}
export interface RecordHistory { id: string; calculationVersion: number; reason: string | null; triggeredBy: string | null; jobId: string | null; snapshot: Record<string, unknown>; createdAt: string }

export interface CorrectionDto {
  id: string; employeeId: string; branchId: string; attendanceDate: string; type: string; originalEventId: string | null; originalPunchedAt: string | null; proposedPunchedAt: string | null; proposedEventType: string | null; proposedStatus: string | null;
  reason: string; status: string; requestedBy: string | null; approvalRequestId: string | null; appliedEventId: string | null; appliedAt: string | null; rejectionReason: string | null; createdAt: string; updatedAt: string; employeeNumber?: string; employeeName?: string;
}

export type RecordDetail = DailyRecord & { ruleSetId: string | null; shiftAssignmentId: string | null; engineVersion: string; trace: CalculationTrace | null; events: RecordEvent[]; history: RecordHistory[]; corrections: CorrectionDto[] };

// ---- monthly grid -----------------------------------------------------------------------------------------------------
export interface MonthlyDayCell { status: string; workedMinutes: number; lateMinutes: number; overtimeMinutes: number; flags: string[]; recordId: string }
export interface MonthlyTotals { present: number; absent: number; leave: number; holiday: number; weeklyOff: number; halfDay: number; late: number; missingPunch: number; workedMinutes: number; overtimeMinutes: number; lateMinutes: number }
export interface MonthlyRow { employeeId: string; employeeNumber: string; employeeName: string; branchId: string; days: Record<string, MonthlyDayCell | null>; totals: MonthlyTotals }

// ---- events / raw / recalculation / locks ------------------------------------------------------------------------------
export interface AttendanceEventDto { id: string; punchedAt: string; localDate: string | null; eventType: string; source: string; verificationMethod: string | null; deviceId: string | null; deviceName: string | null; voidedAt: string | null; correctionId: string | null; note: string | null }

export interface RawTransactionDto {
  id: string; deviceId: string | null; deviceName: string | null; providerKey: string; providerTransactionId: string | null; deviceEmployeeId: string | null; employeeId: string | null; employeeName: string | null; punchedAt: string; deviceLocalTime: string | null; assumedTimezone: string | null;
  clockSkewSeconds: number | null; verificationMethod: string | null; direction: string | null; source: string; processingStatus: string; processingError: string | null; processedAt: string | null; receivedAt: string; syncJobId: string | null; deviceGeneration: number; rawPayload: Record<string, unknown>;
}
export interface RawPage { data: RawTransactionDto[]; meta: { nextCursor: string | null; limit: number } }

export interface RecalculationDto { id: string; fromDate: string; toDate: string; branchId: string | null; departmentId: string | null; employeeIds: string[] | null; reason: string; status: string; summary: Record<string, unknown> | null; requestedBy: string | null; requestedByName: string | null; jobId: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null }
export interface PeriodLockDto { id: string; branchId: string | null; periodStart: string; periodEnd: string; lockedBy: string | null; lockedAt: string; reason: string | null; unlockedBy: string | null; unlockedAt: string | null; unlockReason: string | null; active: boolean }
export interface RecalcAccepted { jobId: string; requestId: string; status: 'QUEUED'; message: string }
