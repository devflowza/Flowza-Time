import { describe, expect, it } from 'vitest';
import { checkLeaveApplication, compOffDaysEarned, daysBetween, decisionOutcome, findOwnOverlap, fmtLeaveDays, monthDates, previewLeaveDaysByMode, shiftLeaveMonth, weekdayOf } from './model';

// Fridays and Saturdays off; 7 October 2026 (a Wednesday) is a holiday
const cal = { weeklyOffDays: [5, 6], holidays: new Set(['2026-10-07']) };

describe('leave model (mirrors @flowza/domain)', () => {
  it('counts working days, or every calendar day for a calendar-mode type; a half day is half of its date', () => {
    // Sun 4 → Sat 10 October: Sun, Mon, Tue, Thu are working (Wed holiday, Fri + Sat off)
    expect(previewLeaveDaysByMode('2026-10-04', '2026-10-10', false, cal)).toBe(4);
    expect(previewLeaveDaysByMode('2026-10-04', '2026-10-10', false, cal, 'calendar')).toBe(7);
    expect(previewLeaveDaysByMode('2026-10-04', '2026-10-04', true, cal)).toBe(0.5);
    expect(previewLeaveDaysByMode('2026-10-09', '2026-10-09', true, cal)).toBe(0); // a Friday
    expect(previewLeaveDaysByMode('2026-10-09', '2026-10-09', true, cal, 'calendar')).toBe(0.5);
    expect(previewLeaveDaysByMode('2026-10-10', '2026-10-04', false, cal)).toBe(0);
  });

  it('refuses what the API refuses an employee, and only warns past the balance (B-46)', () => {
    const base = { type: { allowHalfDay: true, advanceNoticeDays: 0, maxConsecutiveDays: null }, isHalfDay: false, days: 3, startDate: '2026-10-11', today: '2026-10-01', availableAfterPendingDays: 10 };
    expect(checkLeaveApplication(base)).toEqual([]);
    expect(checkLeaveApplication({ ...base, isHalfDay: true, type: { allowHalfDay: false } }).map((i) => [i.code, i.blocking])).toEqual([['HALF_DAY_NOT_ALLOWED', true]]);
    // 7 days' notice: the 5th is too soon, the 8th is exactly enough
    expect(checkLeaveApplication({ ...base, startDate: '2026-10-05', type: { advanceNoticeDays: 7 } })).toEqual([{ code: 'ADVANCE_NOTICE', blocking: true, params: { required: 7, given: 4 } }]);
    expect(checkLeaveApplication({ ...base, startDate: '2026-10-08', type: { advanceNoticeDays: 7 } })).toEqual([]);
    expect(checkLeaveApplication({ ...base, days: 6, type: { maxConsecutiveDays: 5 } })[0]).toMatchObject({ code: 'MAX_CONSECUTIVE', blocking: true, params: { max: 5, days: 6 } });
    expect(checkLeaveApplication({ ...base, days: 12 })).toEqual([{ code: 'OVER_BALANCE', blocking: false, params: { available: 10, days: 12 } }]);
    expect(checkLeaveApplication({ ...base, days: 12, availableAfterPendingDays: null })).toEqual([]);
    expect(checkLeaveApplication({ ...base, days: 2, availableAfterPendingDays: 1, type: { compOff: true } })).toEqual([{ code: 'COMP_OFF_BALANCE', blocking: true, params: { available: 1, days: 2 } }]);
    expect(checkLeaveApplication({ ...base, days: 0 })[0]).toMatchObject({ code: 'NO_DAYS', blocking: true });
  });

  it('B-47: finds the own active leave sharing a date (the edited request itself excluded)', () => {
    const rows = [
      { id: 'a', status: 'APPROVED', startDate: '2026-10-04', endDate: '2026-10-06' },
      { id: 'b', status: 'CANCELLED', startDate: '2026-10-11', endDate: '2026-10-11' },
      { id: 'c', status: 'INFO_REQUESTED', startDate: '2026-10-20', endDate: '2026-10-20' },
    ];
    expect(findOwnOverlap(rows, { startDate: '2026-10-06', endDate: '2026-10-08' })?.id).toBe('a');
    expect(findOwnOverlap(rows, { startDate: '2026-10-11', endDate: '2026-10-11' })).toBeNull(); // cancelled leave frees the date
    expect(findOwnOverlap(rows, { startDate: '2026-10-19', endDate: '2026-10-21' })?.id).toBe('c');
    expect(findOwnOverlap(rows, { startDate: '2026-10-20', endDate: '2026-10-20' }, 'c')).toBeNull();
  });

  it('earns comp-off from the full-day hours: a day, half a day, nothing', () => {
    expect(compOffDaysEarned(480, 8)).toBe(1);
    expect(compOffDaysEarned(300, 8)).toBe(0.5);
    expect(compOffDaysEarned(239, 8)).toBe(0);
  });

  it('P2-9: says "approved" only when the leave is, "level N approved" when only the level moved', () => {
    expect(decisionOutcome({ status: 'APPROVED' }, { decision: 'APPROVED', stepNo: 2 })).toEqual({ key: 'approved', level: 2, waitingFor: [] });
    expect(decisionOutcome({ status: 'PENDING', approvalCurrentStep: 3, approvalWaitingFor: ['Fatma'] }, { decision: 'APPROVED', stepNo: 2 })).toEqual({ key: 'advanced', level: 2, waitingFor: ['Fatma'] });
    // quorum: the level still needs another approver — same level, the leave still pending
    expect(decisionOutcome({ status: 'PENDING', approvalCurrentStep: 2, approvalWaitingFor: ['Mansoor'] }, { decision: 'APPROVED', stepNo: 2 }).key).toBe('approvalRecorded');
    // under ANY a rejection others can still outvote does not reject the leave
    expect(decisionOutcome({ status: 'PENDING', approvalCurrentStep: 1, approvalWaitingFor: ['Mansoor'] }, { decision: 'REJECTED', stepNo: 1 }).key).toBe('rejectionRecorded');
    expect(decisionOutcome({ status: 'REJECTED' }, { decision: 'REJECTED', stepNo: 1 }).key).toBe('rejected');
  });

  it('formats days and walks months', () => {
    expect([fmtLeaveDays(2), fmtLeaveDays(1.5), fmtLeaveDays(null)]).toEqual(['2', '1.5', '—']);
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7);
    expect(shiftLeaveMonth('2026-12', 1)).toBe('2027-01');
    expect(monthDates('2026-02')).toHaveLength(28);
    expect(weekdayOf('2026-10-09')).toBe(5);
  });
});
