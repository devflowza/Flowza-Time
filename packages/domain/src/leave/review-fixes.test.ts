import { describe, expect, it } from 'vitest';
import { allocateCompOffCredits, compOffDemandOf, computeLeaveBalances, type ComputeBalancesInput } from './balances.js';
import { chargedLeaveDates, countLeaveDaysByMode, holidayDates, isWorkingDay, leaveDaysInWindow, type WorkingCalendar } from './days.js';
import { checkLeaveRequest, leaveTypeApplies, leaveTypeAppliesTo, type CheckLeaveRequestInput } from './rules.js';

/**
 * Leave v2 review fixes (docs/hr-portal/reviews/07-leave-v2-review.md) — the pure halves: the per-date working calendar and
 * the stored-days rule (P1-1 / P1-2 / P2-8), the one applicability rule with employment types (P1-3, B-41) and comp-off
 * credits matched against each leave date (P2-4).
 */

// Branch A: Friday + Saturday off until 30 June; branch B (from 1 July): Thursday + Friday off. 2026-05-07 is a Thursday.
const TRANSFER = '2026-07-01';
const perDate: WorkingCalendar = {
  weeklyOffDays: [4, 5], holidays: new Set(),
  isOff: (date) => { const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); return date < TRANSFER ? weekday === 5 || weekday === 6 : weekday === 4 || weekday === 5; },
};

describe('7-P1-1 / 7-P1-2 the per-date working calendar decides a working day', () => {
  it('7-P1-2 a date before a transfer uses the old branch weekly offs, after it the new ones', () => {
    expect(isWorkingDay('2026-05-07', perDate)).toBe(true); // Thursday in branch A: a working day
    expect(isWorkingDay('2026-07-02', perDate)).toBe(false); // Thursday in branch B: weekly off
    // Sun 3 – Thu 7 May: five working days in branch A (the Thursday included) — the review's CAL-2 counted 4
    expect(countLeaveDaysByMode({ startDate: '2026-05-03', endDate: '2026-05-07', isHalfDay: false }, perDate, 'working')).toBe(5);
  });

  it('7-P1-1 a rotation-pattern off day is not charged (the calendar says off even on an ordinary weekday)', () => {
    // Sun–Wed on, Thu–Sat off: the per-date calendar marks the rostered-off Thursday as off
    const rota: WorkingCalendar = { weeklyOffDays: [5, 6], holidays: new Set(), isOff: (d) => [4, 5, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) };
    expect(countLeaveDaysByMode({ startDate: '2026-09-20', endDate: '2026-09-24', isHalfDay: false }, rota, 'working')).toBe(4); // CAL-1: 4, not 5
    expect(chargedLeaveDates({ startDate: '2026-09-20', endDate: '2026-09-24', isHalfDay: false }, rota, 'working').map((d) => d.date)).toEqual(['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']);
  });

  it('without the per-date view the weekly offs and holidays still decide (older callers)', () => {
    const cal: WorkingCalendar = { weeklyOffDays: [5, 6], holidays: holidayDates([{ date: '2026-09-29', endDate: null }]) };
    expect(isWorkingDay('2026-09-29', cal)).toBe(false);
    expect(isWorkingDay('2026-09-24', cal)).toBe(true);
  });
});

describe('7-P1-2 / 7-P2-8 the stored days of a leave are the document', () => {
  const window2026 = { from: '2026-01-01', to: '2026-12-31' };
  it('7-P1-2 a leave inside the window charges its stored days, whatever the calendar says now', () => {
    // stored 5 at submission (branch A); after the transfer the calendar would count the same dates as 4 — history stays 5
    expect(leaveDaysInWindow({ startDate: '2026-05-03', endDate: '2026-05-07', isHalfDay: false, days: 5 }, { weeklyOffDays: [4, 5], holidays: new Set() }, 'working', window2026)).toBe(5);
  });
  it('7-P2-8 a leave without stored days (before leave v2) is counted on read; a leave crossing the window counts only the dates inside it', () => {
    expect(leaveDaysInWindow({ startDate: '2026-05-03', endDate: '2026-05-07', isHalfDay: false, days: null }, perDate, 'working', window2026)).toBe(5);
    // Sun 27 Sep – Thu 8 Oct, Fri/Sat off: September holds Sun 27 – Wed 30 = 4 of its 10 days (the review's T5 total read 10)
    const fs: WorkingCalendar = { weeklyOffDays: [5, 6], holidays: new Set() };
    expect(leaveDaysInWindow({ startDate: '2026-09-27', endDate: '2026-10-08', isHalfDay: false, days: 10 }, fs, 'working', { from: '2026-09-01', to: '2026-09-30' })).toBe(4);
    expect(leaveDaysInWindow({ startDate: '2026-09-27', endDate: '2026-10-08', isHalfDay: false, days: 10 }, fs, 'working')).toBe(10);
  });
  it('7-P1-2 balances take the stored days: a transfer after the leave never moves "taken"', () => {
    const input: ComputeBalancesInput = {
      year: 2026, asOf: '2026-09-27', joiningDate: '2020-01-01', allocations: [], calendar: { weeklyOffDays: [4, 5], holidays: new Set() },
      types: [{ leaveTypeId: 'AL', annualAllowanceDays: 20, countMode: 'working', accrual: 'none' }],
      records: [{ leaveTypeId: 'AL', status: 'APPROVED', startDate: '2026-05-03', endDate: '2026-05-07', isHalfDay: false, days: 5 }],
    };
    // CAL-3: before the fix the new branch's Thursday off made "taken" 4 and gave the employee a day back
    expect(computeLeaveBalances(input)[0]).toMatchObject({ takenDays: 5, availableDays: 15 });
  });
});

describe('7-P1-3 one applicability rule: gender and employment type (B-41)', () => {
  const type = { applicableGender: 'all' as const, applicableEmploymentTypes: ['full_time', 'part_time'] };
  it('7-P1-3 an employment-type restricted type applies only to those employment types on file', () => {
    expect(leaveTypeAppliesTo(type, { gender: 'male', employmentType: 'full_time' })).toBe(true);
    expect(leaveTypeAppliesTo(type, { gender: 'male', employmentType: 'contract' })).toBe(false);
    expect(leaveTypeAppliesTo(type, { gender: 'male', employmentType: null })).toBe(false);
    expect(leaveTypeAppliesTo({ applicableGender: 'all', applicableEmploymentTypes: null }, { gender: 'male', employmentType: 'intern' })).toBe(true);
    expect(leaveTypeAppliesTo({ applicableGender: 'all', applicableEmploymentTypes: [] }, { gender: 'male', employmentType: 'intern' })).toBe(true);
  });
  it('7-P1-3 gender AND employment type must both match', () => {
    expect(leaveTypeAppliesTo({ applicableGender: 'male', applicableEmploymentTypes: ['full_time'] }, { gender: 'female', employmentType: 'full_time' })).toBe(false);
    expect(leaveTypeAppliesTo({ applicableGender: 'male', applicableEmploymentTypes: null }, { gender: 'female', employmentType: 'full_time' })).toBe(leaveTypeApplies('male', 'female'));
  });
  it('7-P1-3 the request matrix refuses a type whose employment types exclude the employee (NOT_APPLICABLE)', () => {
    const input: CheckLeaveRequestInput = {
      type: { name: 'Study Leave', applicableGender: 'all', applicableEmploymentTypes: ['full_time'], allowHalfDay: true, advanceNoticeDays: 0, maxConsecutiveDays: null },
      employeeGender: 'female', employeeEmploymentType: 'contract', startDate: '2026-10-04', endDate: '2026-10-04', isHalfDay: false, days: 1, today: '2026-09-27', asHr: true, availableAfterPendingDays: null,
    };
    const res = checkLeaveRequest(input);
    expect(res.errors.map((e) => e.code)).toEqual(['NOT_APPLICABLE']);
    expect(res.errors[0]!.message).toContain('full-time');
    expect(checkLeaveRequest({ ...input, employeeEmploymentType: 'full_time' }).errors).toEqual([]);
  });
});

describe('7-P2-4 a comp-off credit pays only for leave dated on or before its expiry', () => {
  it('7-P2-4 a leave dated after the credit expires is not paid (the review CO-1)', () => {
    const plan = allocateCompOffCredits([{ id: 'c1', freeDays: 1, expiresOn: '2026-10-08' }], [{ date: '2027-02-14', days: 1 }]);
    expect(plan.usages).toEqual([]);
    expect(plan.shortfall.get('')).toBe(1);
  });
  it('7-P2-4 each date takes the credit expiring first among those still valid on it', () => {
    const credits = [{ id: 'late', freeDays: 1, expiresOn: '2026-12-31' }, { id: 'early', freeDays: 1, expiresOn: '2026-10-05' }];
    const plan = allocateCompOffCredits(credits, [{ date: '2026-10-04', days: 1 }, { date: '2026-10-06', days: 1 }]);
    expect(plan.usages.sort((a, b) => a.creditId.localeCompare(b.creditId))).toEqual([{ creditId: 'early', days: 1, key: '' }, { creditId: 'late', days: 1, key: '' }]);
    expect(plan.shortfall.size).toBe(0);
    // the other way round (the later date first in the input) the result is the same: dates are served in date order
    expect(allocateCompOffCredits(credits, [{ date: '2026-10-06', days: 1 }, { date: '2026-10-04', days: 1 }]).shortfall.size).toBe(0);
  });
  it('7-P2-4 a credit valid for the first dates only pays those dates; other requests reserve theirs first', () => {
    const plan = allocateCompOffCredits([{ id: 'c1', freeDays: 1, expiresOn: '2026-10-05' }, { id: 'c2', freeDays: 0.5, expiresOn: '2026-10-31' }],
      [{ date: '2026-10-05', days: 1, key: 'this' }, { date: '2026-10-05', days: 0.5, key: 'other' }, { date: '2026-10-06', days: 1, key: 'this' }], { lastKey: 'this' });
    // "other" is served first (c1 half), then "this" takes the rest of c1 (0.5) and c2 (0.5) on the 5th; nothing is left for the 6th
    expect(plan.shortfall.get('this')).toBe(1);
    expect(plan.shortfall.get('other')).toBeUndefined();
    // an application dated before a pending request never takes the credit that request holds
    const held = allocateCompOffCredits([{ id: 'c', freeDays: 1, expiresOn: '2026-10-08' }], [{ date: '2026-10-08', days: 1, key: 'pending' }, { date: '2026-10-07', days: 1, key: 'this' }], { lastKey: 'this' });
    expect([held.shortfall.get('this'), held.shortfall.get('pending')]).toEqual([1, undefined]);
  });
  it('7-P2-4 the demand of a leave: its charged dates, or — when the stored days no longer match — the stored figure on its last date', () => {
    const fs: WorkingCalendar = { weeklyOffDays: [5, 6], holidays: new Set() };
    expect(compOffDemandOf({ startDate: '2026-10-01', endDate: '2026-10-04', isHalfDay: false, days: 2 }, fs, 'working')).toEqual([{ date: '2026-10-01', days: 1 }, { date: '2026-10-04', days: 1 }]);
    expect(compOffDemandOf({ startDate: '2026-10-01', endDate: '2026-10-04', isHalfDay: false, days: 3 }, fs, 'working', 'k')).toEqual([{ date: '2026-10-04', days: 3, key: 'k' }]);
    expect(compOffDemandOf({ startDate: '2026-10-01', endDate: '2026-10-01', isHalfDay: true, days: null }, fs, 'working')).toEqual([{ date: '2026-10-01', days: 0.5 }]);
  });
});
