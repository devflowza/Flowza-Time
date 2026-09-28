import type { AttendanceNoteReviewItemDto, TeamLeaveDto, TeamMemberTodayDto, TeamSummaryDto, TeamTotalsDto } from '@flowza/contracts';

/** Test data for the team workspace (no application imports: safe to use next to vi.mock). */
export function teamMember(over: Partial<TeamMemberTodayDto> = {}): TeamMemberTodayDto {
  return {
    employeeId: 'e5', employeeNumber: 'E005', employeeName: 'Salma Al Harthy', designationName: 'Engineer', departmentName: 'IT', branchId: 'b1', branchName: 'Muscat', relation: 'primary',
    date: '2026-09-28', timezone: 'Asia/Muscat', status: 'present', recordStatus: 'PRESENT', recordId: 'r5', flags: [], firstInAt: '2026-09-28T04:00:00Z', lastOutAt: null,
    liveState: 'IN', lastPunchAt: '2026-09-28T04:00:00Z', workedMinutes: 125, workedIsLive: true, lateMinutes: 0, leave: null, pendingItems: 0,
    ...over,
  };
}

export function teamTotals(members: readonly TeamMemberTodayDto[]): TeamTotalsDto {
  const n = (s: TeamMemberTodayDto['status']) => members.filter((m) => m.status === s).length;
  return {
    reports: members.length, present: n('present') + n('late'), late: n('late'), absent: n('absent'), onLeave: n('on_leave'), missingPunch: n('missing_punch'), weeklyOff: n('weekly_off'),
    holiday: n('holiday'), notInYet: n('not_in_yet'), inNow: members.filter((m) => m.liveState === 'IN').length, pendingItems: members.reduce((a, m) => a + m.pendingItems, 0),
  };
}

export const teamSummary = (members: TeamMemberTodayDto[]): TeamSummaryDto => ({ date: '2026-09-28', generatedAt: new Date().toISOString(), members, totals: teamTotals(members) });

export function teamLeave(over: Partial<TeamLeaveDto> = {}): TeamLeaveDto {
  return { id: 'lv1', employeeId: 'e6', employeeName: 'Yousuf Al Balushi', employeeNumber: 'E006', leaveTypeId: 'lt1', leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', color: '#16a34a', startDate: '2026-09-28', endDate: '2026-09-30', isHalfDay: false, halfDayPart: null, days: 3, status: 'APPROVED', ...over };
}

export function reviewNote(over: Partial<AttendanceNoteReviewItemDto> = {}): AttendanceNoteReviewItemDto {
  return {
    id: 'n1', employeeId: 'e5', attendanceDate: '2026-09-27', category: 'late_reason', note: 'Traffic accident on the highway', status: 'pending', submittedAt: '2026-09-27T09:00:00Z', reviewedBy: null, reviewedByName: null, reviewedAt: null,
    reviewReason: null, reviewVia: null, infoRequestMessage: null, infoRequestedAt: null, payEffectDays: null, lossOfPay: false, deductedLeaveTypeCode: null, deductedLeaveTypeName: null, approvalRequestId: null, approvalStatus: null, approvalCurrentStep: null, approvalStepCount: null,
    excusedAt: null, createdAt: '2026-09-27T09:00:00Z', updatedAt: '2026-09-27T09:00:00Z',
    employeeName: 'Salma Al Harthy', employeeNumber: 'E005', branchId: 'b1', branchName: 'Muscat', dayStatus: 'PRESENT', dayFlags: ['LATE'], firstInAt: '2026-09-27T04:40:00Z', lastOutAt: '2026-09-27T13:00:00Z', timezone: 'Asia/Muscat',
    excusedCountYear: 2, isOversight: false, canReview: true,
    ...over,
  };
}
