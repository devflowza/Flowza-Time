import { describe, expect, it } from 'vitest';
import { checkLeaveRequest, compOffDaysEarned, daysBetween, leaveTypeApplies, type CheckLeaveRequestInput } from './rules.js';

const type = { name: 'Annual Leave', applicableGender: 'all' as const, allowHalfDay: true, advanceNoticeDays: 0, maxConsecutiveDays: null };
const input = (over: Partial<CheckLeaveRequestInput> = {}): CheckLeaveRequestInput => ({ type, employeeGender: 'female', startDate: '2026-10-04', endDate: '2026-10-05', isHalfDay: false, days: 2, today: '2026-09-27', asHr: false, availableAfterPendingDays: 20, ...over });
const codes = (xs: Array<{ code: string }>) => xs.map((x) => x.code);

describe('applicability', () => {
  it('matches gender strictly', () => {
    expect(leaveTypeApplies('all', 'unspecified')).toBe(true);
    expect(leaveTypeApplies('female', 'female')).toBe(true);
    expect(leaveTypeApplies('female', 'male')).toBe(false);
    expect(leaveTypeApplies('female', 'unspecified')).toBe(false);
    expect(leaveTypeApplies('male', null)).toBe(false);
  });
  it('refuses a type that does not apply, for HR as well', () => {
    const r = checkLeaveRequest(input({ type: { ...type, name: 'Maternity', applicableGender: 'female' }, employeeGender: 'male', asHr: true }));
    expect(codes(r.errors)).toEqual(['NOT_APPLICABLE']);
    expect(r.errors[0]!.path).toBe('leaveTypeId');
  });
});

describe('the validation matrix', () => {
  it('a plain request passes', () => {
    expect(checkLeaveRequest(input())).toEqual({ errors: [], warnings: [] });
  });
  it('half days only where the type allows them', () => {
    expect(codes(checkLeaveRequest(input({ type: { ...type, allowHalfDay: false }, isHalfDay: true, endDate: '2026-10-04', days: 0.5 })).errors)).toEqual(['HALF_DAY_NOT_ALLOWED']);
    expect(checkLeaveRequest(input({ isHalfDay: true, endDate: '2026-10-04', days: 0.5 })).errors).toEqual([]);
  });
  it('a range without a working day is refused', () => {
    expect(codes(checkLeaveRequest(input({ days: 0 })).errors)).toEqual(['NO_DAYS']);
  });
  it('advance notice: an error for self-service, a warning for HR', () => {
    const t = { ...type, advanceNoticeDays: 14 };
    expect(codes(checkLeaveRequest(input({ type: t })).errors)).toEqual(['ADVANCE_NOTICE']);
    const hr = checkLeaveRequest(input({ type: t, asHr: true }));
    expect(hr.errors).toEqual([]);
    expect(codes(hr.warnings)).toEqual(['ADVANCE_NOTICE']);
    expect(hr.warnings[0]!.params).toEqual({ required: 14, given: 7 });
    // exactly the notice period is enough
    expect(checkLeaveRequest(input({ type: { ...type, advanceNoticeDays: 7 } })).errors).toEqual([]);
  });
  it('max consecutive days: an error for self-service, a warning for HR', () => {
    const t = { ...type, maxConsecutiveDays: 3 };
    expect(codes(checkLeaveRequest(input({ type: t, days: 4 })).errors)).toEqual(['MAX_CONSECUTIVE']);
    expect(codes(checkLeaveRequest(input({ type: t, days: 4, asHr: true })).warnings)).toEqual(['MAX_CONSECUTIVE']);
    expect(checkLeaveRequest(input({ type: t, days: 3 })).errors).toEqual([]);
  });
  it('the balance warns, never blocks (B-46)', () => {
    const r = checkLeaveRequest(input({ availableAfterPendingDays: 1, days: 2 }));
    expect(r.errors).toEqual([]);
    expect(codes(r.warnings)).toEqual(['OVER_BALANCE']);
    expect(r.warnings[0]!.params).toMatchObject({ available: 1, days: 2, after: -1 });
    expect(checkLeaveRequest(input({ availableAfterPendingDays: null, days: 40 })).warnings).toEqual([]);
  });
  it('a comp-off redemption never exceeds the comp-off balance (B-60)', () => {
    const co = { ...type, name: 'Compensatory Off', compOff: true };
    expect(codes(checkLeaveRequest(input({ type: co, availableAfterPendingDays: 1, days: 2 })).errors)).toEqual(['COMP_OFF_BALANCE']);
    expect(codes(checkLeaveRequest(input({ type: co, availableAfterPendingDays: 1, days: 2, asHr: true })).errors)).toEqual(['COMP_OFF_BALANCE']);
    expect(checkLeaveRequest(input({ type: co, availableAfterPendingDays: 2, days: 2 })).errors).toEqual([]);
  });
  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-09-27', '2026-10-04')).toBe(7);
    expect(daysBetween('2026-09-27', '2026-09-20')).toBe(-7);
  });
});

describe('comp-off days earned', () => {
  it('full day from fullDayHours, half from half of it, nothing below', () => {
    expect(compOffDaysEarned(480, 8)).toBe(1);
    expect(compOffDaysEarned(479, 8)).toBe(0.5);
    expect(compOffDaysEarned(240, 8)).toBe(0.5);
    expect(compOffDaysEarned(239, 8)).toBe(0);
    expect(compOffDaysEarned(540, 9)).toBe(1);
    expect(compOffDaysEarned(0, 8)).toBe(0);
  });
});
