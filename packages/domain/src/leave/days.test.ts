import { describe, expect, it } from 'vitest';
import { countLeaveDays, holidayDates, isWorkingDay, leaveBalances, type WorkingCalendar } from './days.js';

// Oman: Friday + Saturday off. 2026-09-25 is a Friday.
const cal: WorkingCalendar = { weeklyOffDays: [5, 6], holidays: holidayDates([{ date: '2026-09-29', endDate: null }]) };

describe('isWorkingDay', () => {
  it('skips weekly offs and holidays', () => {
    expect(isWorkingDay('2026-09-24', cal)).toBe(true); // Thursday
    expect(isWorkingDay('2026-09-25', cal)).toBe(false); // Friday
    expect(isWorkingDay('2026-09-26', cal)).toBe(false); // Saturday
    expect(isWorkingDay('2026-09-29', cal)).toBe(false); // holiday
  });
});

describe('countLeaveDays', () => {
  it('charges only working days in the range', () => {
    // Thu 24 → Wed 30 Sep: Thu, Sun, Mon, Wed (Fri/Sat off, Tue 29 holiday)
    expect(countLeaveDays({ startDate: '2026-09-24', endDate: '2026-09-30', isHalfDay: false }, cal)).toBe(4);
  });
  it('charges a half day as 0.5, and nothing on a day off', () => {
    expect(countLeaveDays({ startDate: '2026-09-24', endDate: '2026-09-24', isHalfDay: true }, cal)).toBe(0.5);
    expect(countLeaveDays({ startDate: '2026-09-25', endDate: '2026-09-25', isHalfDay: true }, cal)).toBe(0);
  });
  it('clips to a window', () => {
    expect(countLeaveDays({ startDate: '2026-12-28', endDate: '2027-01-05', isHalfDay: false }, { weeklyOffDays: [], holidays: new Set() }, { from: '2026-01-01', to: '2026-12-31' })).toBe(4);
    expect(countLeaveDays({ startDate: '2025-12-01', endDate: '2025-12-02', isHalfDay: false }, cal, { from: '2026-01-01', to: '2026-12-31' })).toBe(0);
  });
  it('expands multi-day holidays', () => {
    expect([...holidayDates([{ date: '2026-03-19', endDate: '2026-03-21' }])]).toEqual(['2026-03-19', '2026-03-20', '2026-03-21']);
  });
});

describe('leaveBalances', () => {
  it('counts approved as used and pending as pending; ignores rejected/cancelled', () => {
    const records = [
      { leaveTypeId: 'AL', status: 'APPROVED', startDate: '2026-08-23', endDate: '2026-08-27', isHalfDay: false }, // Sun–Thu: 5
      { leaveTypeId: 'AL', status: 'PENDING', startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false }, // Sun–Thu: 5
      { leaveTypeId: 'AL', status: 'REJECTED', startDate: '2026-06-14', endDate: '2026-06-18', isHalfDay: false },
      { leaveTypeId: 'AL', status: 'CANCELLED', startDate: '2026-05-17', endDate: '2026-05-21', isHalfDay: false },
      { leaveTypeId: 'SL', status: 'APPROVED', startDate: '2026-04-07', endDate: '2026-04-08', isHalfDay: false },
    ];
    const out = leaveBalances([{ leaveTypeId: 'AL', allowanceDays: 30 }, { leaveTypeId: 'SL', allowanceDays: null }], records, cal, 2026);
    expect(out).toEqual([
      { leaveTypeId: 'AL', allowanceDays: 30, usedDays: 5, pendingDays: 5, remainingDays: 20 },
      { leaveTypeId: 'SL', allowanceDays: null, usedDays: 2, pendingDays: 0, remainingDays: null },
    ]);
  });
});
