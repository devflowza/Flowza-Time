export interface LeaveTypeDto { id: string; code: string; name: string; nameAr: string | null; isPaid: boolean; color: string | null; status: string; createdAt: string }
export interface LeaveRecordDto {
  id: string; employeeId: string; employeeNumber?: string; employeeName?: string; leaveTypeId: string; leaveTypeName?: string; branchId: string | null; startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null;
  reason: string | null; status: string; source: string; approvedBy: string | null; approvedAt: string | null; createdBy: string | null; createdAt: string; updatedAt: string;
}
export type WithRecalc<T> = T & { recalculationJobId: string | null };
