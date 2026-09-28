import { BRANCH_A, HQ_FENCE, ORG_ID, PORTAL_EMPLOYEE_ID, employeesFixture, organization, type MockBackendOptions } from './mock-backend';

/**
 * Data for the UI walk (e2e/ui-walk.spec.ts): the object-shaped endpoints the new HR-portal pages read, filled like a normal
 * working month, so every page renders its populated state (lists fall back to the double's empty pages otherwise).
 */
const today = new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const month = today.slice(0, 7);
const me = `/orgs/${ORG_ID}/me`;
const sara = employeesFixture[1]!;

function dayRecord(date: string, over: Record<string, unknown> = {}) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const off = dow === 5 || dow === 6;
  return {
    id: `rec-${date}`, employeeId: PORTAL_EMPLOYEE_ID, employeeNumber: sara.employeeNumber, employeeName: sara.displayName, attendanceDate: date, branchId: BRANCH_A, branchName: 'Muscat HQ', departmentId: null, departmentName: 'Operations',
    shiftId: 's1', shiftName: 'Office 08:00–17:00', timezone: 'Asia/Muscat', expectedStartAt: off ? null : `${date}T04:00:00Z`, expectedEndAt: off ? null : `${date}T13:00:00Z`, scheduledMinutes: off ? 0 : 480,
    firstInAt: off ? null : `${date}T04:0${dow % 6}:00Z`, lastOutAt: off ? null : `${date}T13:1${dow % 6}:00Z`, workedMinutes: off ? 0 : 540, breakMinutes: 0, lateMinutes: dow === 1 ? 12 : 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null,
    status: off ? 'WEEKLY_OFF' : 'PRESENT', flags: dow === 1 ? ['LATE'] : [], punchCount: off ? 0 : 2, hasCorrection: false, calculationVersion: 1, computedAt: `${date}T14:00:00Z`, lockedAt: null, lopDays: 0, unexcused: false, ...over,
  };
}
const monthDays = () => { const out = []; for (let d = `${month}-01`; d < today; d = addDays(d, 1)) out.push(dayRecord(d)); return out; };
const totals = { present: 17, absent: 1, leave: 1, holiday: 0, weeklyOff: 8, halfDay: 0, late: 3, missingPunch: 1, workedMinutes: 9180, overtimeMinutes: 45, lateMinutes: 36, earlyDepartureMinutes: 0, workingDays: 19, attendedDays: 18, attendanceRate: 18 / 19 };
const punctuality = (from: string, to: string) => ({ from, to, days: 5, onTimeDays: 4, lateDays: 1, avgArrivalDeltaMinutes: 3, totalDelayMinutes: 12, avgDelayMinutes: 12 });
const shiftSummary = { id: 's1', code: 'OFFICE', name: 'Office 08:00–17:00', type: 'FIXED', startTime: '08:00', endTime: '17:00', requiredMinutes: 480, graceInMinutes: 10, crossesMidnight: false, color: '#175cd3', breakMinutes: 60 };
const shiftDay = (i: number) => {
  const date = addDays(today, i);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, shift: dow === 5 || dow === 6 ? null : shiftSummary, source: 'ASSIGNMENT', isOff: dow === 5 || dow === 6, holidayName: null, onLeave: false, swap: i === 4 ? { id: 'sw1', status: 'pending', withEmployeeName: 'Khalid Al Balushi' } : null };
};

export const walkProfile = {
  employeeId: PORTAL_EMPLOYEE_ID, employeeNumber: sara.employeeNumber, displayName: sara.displayName, displayNameAr: 'مريم اللواتي', firstName: 'Maryam', lastName: 'Al Lawati', email: sara.email, phone: '+968 9123 4567',
  gender: 'female', dateOfBirth: null, nationality: 'OM', joiningDate: '2024-02-01', employmentStatus: 'active', employmentType: 'full_time', photoUrl: null,
  branch: { id: BRANCH_A, name: 'Muscat HQ', timezone: 'Asia/Muscat' }, department: { id: 'dep1', name: 'Operations' }, designation: { id: 'des1', name: 'Operations Supervisor' },
  manager: { id: employeesFixture[0]!.id, name: employeesFixture[0]!.displayName, employeeNumber: employeesFixture[0]!.employeeNumber }, secondaryManager: null, teams: [{ id: 't1', name: 'Warehouse team' }], weeklyOffDays: [5, 6], roleName: 'Owner',
};

/** GET handlers of the walk (spread into installMockBackend's `get`). */
export function walkGetHandlers(): NonNullable<MockBackendOptions['get']> {
  return {
    [`${me}/overview`]: {
      data: {
        date: today, timezone: 'Asia/Muscat', today: dayRecord(today, { lastOutAt: null, workedMinutes: 0, status: 'PENDING', punchCount: 1 }), month: { month, totals }, recent: monthDays().slice(-5).reverse(),
        balances: [{ leaveTypeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', allowanceDays: 30, usedDays: 7, pendingDays: 2, remainingDays: 21, name: 'Annual Leave', nameAr: 'إجازة سنوية', code: 'AL', color: '#175cd3' }],
        upcomingLeave: [], pendingLeave: 1, pendingCorrections: 0, upcomingHolidays: [{ date: addDays(today, 50), endDate: addDays(today, 51), name: 'National Day', nameAr: 'العيد الوطني' }],
        punch: { lastDirection: 'in', lastPunchAt: `${today}T04:05:00Z`, punchesToday: 1, canCheckIn: false, canCheckOut: true, checkInEnabled: true },
        pendingNotes: 1, infoRequestedNotes: 0, pendingRegularisations: 1, pendingSwaps: 0,
      },
    },
    [`${me}/profile`]: { data: walkProfile },
    [`${me}/attendance`]: { data: { month, days: monthDays(), totals, leaveByDate: {}, holidaysByDate: {} } },
    [`${me}/stats`]: (url: URL) => ({
      data: {
        range: url.searchParams.get('range') ?? '30d', from: addDays(today, -29), to: today, workingDays: 21, presentDays: 19, halfDays: 0, absentDays: 1, leaveDays: 1, lateDays: 3, missingCheckouts: 1, workedDays: 19, workedMinutes: 10_260,
        avgHoursPerDay: 9, attendancePct: 95.2, targets: { attendancePct: 95, fullDayHours: 8 }, hints: [{ kind: 'late_days', value: 3, target: 2 }],
        punctuality: { last7Days: punctuality(addDays(today, -6), today), thisMonth: punctuality(`${month}-01`, today), lastMonth: punctuality(addDays(`${month}-01`, -30), addDays(`${month}-01`, -1)) },
      },
    }),
    [`${me}/shift`]: { data: { date: today, timezone: 'Asia/Muscat', today: shiftDay(0), upcoming: Array.from({ length: 14 }, (_, i) => shiftDay(i + 1)), history: [{ id: 'a1', targetType: 'BRANCH', shiftName: shiftSummary.name, patternName: null, effectiveFrom: '2026-01-01', effectiveTo: null, isSwap: false }] } },
    [`${me}/shift-swaps`]: { data: [] },
    [`${me}/selfie-checkins`]: { data: [] },
    [`${me}/team/leave`]: { data: [] },
    [`/orgs/${ORG_ID}/team/pending-counts`]: { data: { approvals: 1, notes: 1, total: 2 } },
    [`/orgs/${ORG_ID}/attendance/notes/report`]: {
      data: [{
        id: 'efefefef-efef-4fef-8fef-000000000011', employeeId: sara.id, employeeName: sara.displayName, employeeNumber: sara.employeeNumber, branchId: BRANCH_A, branchName: 'Muscat HQ', departmentName: 'Operations',
        attendanceDate: addDays(today, -5), dayStatus: 'ABSENT', dayFlags: [], category: 'absence_reason', note: 'Fever; the clinic slip is attached', status: 'approved', approvalStatus: 'APPROVED', approvalCurrentStep: null, approvalStepCount: 1,
        submittedAt: `${addDays(today, -5)}T08:00:00Z`, reviewedByName: 'Khalid Al Balushi', reviewedAt: `${addDays(today, -4)}T06:00:00Z`, reviewVia: 'manager', reviewReason: null, payEffectDays: 1, impact: 'leave', lossOfPay: false,
        deductedLeaveTypeCode: 'SL', deductedLeaveTypeName: 'Sick Leave', deductedLeaveDays: 1, excusedCountYear: 2, isOversight: false,
      }],
      meta: { page: 1, pageSize: 25, total: 1, totalPages: 1, totals: { total: 1, pending: 0, approved: 1, rejected: 0, excused: 0, infoRequested: 0, lopDays: 0, leaveDays: 1 } },
    },
    [`/orgs/${ORG_ID}`]: { data: organization },
    [`/orgs/${ORG_ID}/settings/notifications`]: { data: {} },
    [`/orgs/${ORG_ID}/settings/reports`]: { data: {} },
    [`/orgs/${ORG_ID}/settings/attendance`]: { data: {} },
    [`/orgs/${ORG_ID}/geofences`]: {
      data: [{
        id: HQ_FENCE.id, organizationId: ORG_ID, branchId: BRANCH_A, branchName: 'Muscat HQ', name: 'Muscat HQ — main building', latitude: HQ_FENCE.latitude, longitude: HQ_FENCE.longitude, radiusM: 150, polygon: null, enforcement: 'soft_warn', accuracyThresholdM: 100, graceM: 20,
        activeFrom: null, activeTo: null, timeWindows: [], isActive: true, editable: true, hiddenAssignments: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        assignments: [{ id: 'ga1', geofenceId: HQ_FENCE.id, scope: 'branch', targetId: BRANCH_A, targetName: 'Muscat HQ', priority: 100, requireOnCheckIn: true, requireOnCheckOut: true, createdAt: '2026-01-01T00:00:00Z' }],
      }],
    },
    [`/orgs/${ORG_ID}/attendance/regularisations`]: {
      data: [{
        id: 'efefefef-efef-4fef-8fef-000000000009', employeeId: sara.id, attendanceDate: addDays(today, -3), type: 'missed_punch', proposedInAt: null, proposedOutAt: `${addDays(today, -3)}T13:40:00Z`, reason: 'Left through the side gate; the reader was off', status: 'pending',
        approvalRequestId: 'efefefef-efef-4fef-8fef-0000000000ab', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 2, appliedCorrectionId: null, appliedAt: null, decidedByName: null, decidedAt: null, decisionNote: null, createdAt: `${addDays(today, -2)}T06:00:00Z`, updatedAt: `${addDays(today, -2)}T06:00:00Z`,
        employeeName: sara.displayName, employeeNumber: sara.employeeNumber, branchId: BRANCH_A, branchName: 'Muscat HQ', departmentId: null, departmentName: 'Operations', approval: null,
      }],
      meta: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    },
    [`/orgs/${ORG_ID}/report-recipients`]: { data: { users: [{ userId: 'u-payroll', displayName: 'Payroll Team', email: 'payroll@albahja.example', roleKey: 'payroll', roleName: 'Payroll', isManager: false, branchCount: null }], roles: [{ key: 'payroll', name: 'Payroll', members: 2 }] } },
    '/report-types': { data: [] },
  };
}

