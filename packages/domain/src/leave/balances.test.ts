import { describe, expect, it } from 'vitest';
import { accruedToDate, carryForwardDays, carryForwardExpiry, clampToYear, computeLeaveBalances, leaveBalances, monthsInRange, prorateAllowance, serviceStartInYear, type ComputeBalancesInput } from './balances.js';
import { countLeaveDaysByMode, holidayDates, type WorkingCalendar } from './days.js';

// Oman: Friday + Saturday off; 2026-09-29 (Tue) a holiday. 2026-09-25 is a Friday.
const cal: WorkingCalendar = { weeklyOffDays: [5, 6], holidays: holidayDates([{ date: '2026-09-29', endDate: null }]) };
const AL = { leaveTypeId: 'AL', annualAllowanceDays: 30, countMode: 'working' as const, accrual: 'none' as const };
const base = (over: Partial<ComputeBalancesInput> = {}): ComputeBalancesInput => ({ year: 2026, asOf: '2026-09-27', joiningDate: '2020-01-01', types: [AL], allocations: [], records: [], calendar: cal, ...over });

describe('count modes', () => {
  it('working counts working days, calendar counts every date', () => {
    const r = { startDate: '2026-09-24', endDate: '2026-09-30', isHalfDay: false };
    expect(countLeaveDaysByMode(r, cal, 'working')).toBe(4); // Thu, Sun, Mon, Wed
    expect(countLeaveDaysByMode(r, cal, 'calendar')).toBe(7);
    expect(countLeaveDaysByMode({ startDate: '2026-09-25', endDate: '2026-09-25', isHalfDay: true }, cal, 'calendar')).toBe(0.5);
    expect(countLeaveDaysByMode({ startDate: '2026-12-30', endDate: '2027-01-02', isHalfDay: false }, cal, 'calendar', { from: '2026-01-01', to: '2026-12-31' })).toBe(2);
  });
});

describe('computeLeaveBalances — entitlement, taken, pending', () => {
  it('uses the type allowance without an allocation row; approved = taken, pending + info requested = pending', () => {
    const [b] = computeLeaveBalances(base({ records: [
      { leaveTypeId: 'AL', status: 'APPROVED', startDate: '2026-08-23', endDate: '2026-08-27', isHalfDay: false }, // Sun–Thu 5
      { leaveTypeId: 'AL', status: 'PENDING', startDate: '2026-10-04', endDate: '2026-10-05', isHalfDay: false }, // 2
      { leaveTypeId: 'AL', status: 'INFO_REQUESTED', startDate: '2026-10-06', endDate: '2026-10-06', isHalfDay: true }, // 0.5
      { leaveTypeId: 'AL', status: 'REJECTED', startDate: '2026-06-14', endDate: '2026-06-18', isHalfDay: false },
      { leaveTypeId: 'AL', status: 'CANCELLED', startDate: '2026-05-17', endDate: '2026-05-21', isHalfDay: false },
      { leaveTypeId: 'SL', status: 'APPROVED', startDate: '2026-04-07', endDate: '2026-04-08', isHalfDay: false },
    ] }));
    expect(b).toMatchObject({ tracked: true, hasAllocation: false, allocatedDays: 30, entitlementDays: 30, takenDays: 5, pendingDays: 2.5, availableDays: 25, availableAfterPendingDays: 22.5, accruedToDateDays: null });
  });

  it('counts a calendar-mode type by calendar days and clips ranges to the year', () => {
    const [b] = computeLeaveBalances(base({ types: [{ ...AL, countMode: 'calendar' }], records: [
      { leaveTypeId: 'AL', status: 'APPROVED', startDate: '2026-09-24', endDate: '2026-09-30', isHalfDay: false }, // 7 calendar days
      { leaveTypeId: 'AL', status: 'APPROVED', startDate: '2025-12-30', endDate: '2026-01-02', isHalfDay: false }, // 2 inside 2026
    ] }));
    expect(b!.takenDays).toBe(9);
    expect(b!.availableDays).toBe(21);
  });

  it('an allocation row replaces the allowance; opening balance and adjustment add up', () => {
    const [b] = computeLeaveBalances(base({ allocations: [{ leaveTypeId: 'AL', allocatedDays: 24, carriedForwardDays: 0, carriedForwardExpiresOn: null, openingBalanceDays: 3.5, adjustmentDays: -1 }] }));
    expect(b).toMatchObject({ hasAllocation: true, allocatedDays: 24, openingBalanceDays: 3.5, adjustmentDays: -1, entitlementDays: 26.5, availableDays: 26.5 });
  });

  it('an allocation row of another year is ignored', () => {
    const [b] = computeLeaveBalances(base({ allocations: [{ leaveTypeId: 'AL', year: 2025, allocatedDays: 10, carriedForwardDays: 0, carriedForwardExpiresOn: null, openingBalanceDays: 0, adjustmentDays: 0 }] }));
    expect(b).toMatchObject({ hasAllocation: false, entitlementDays: 30 });
  });

  it('an untracked type (no allowance, no row) reports usage only', () => {
    const [b] = computeLeaveBalances(base({ types: [{ ...AL, annualAllowanceDays: null }], records: [{ leaveTypeId: 'AL', status: 'APPROVED', startDate: '2026-09-24', endDate: '2026-09-24', isHalfDay: false }] }));
    expect(b).toMatchObject({ tracked: false, entitlementDays: null, availableDays: null, takenDays: 1 });
  });

  it('prorates the allowance for a joiner of the year when there is no allocation row', () => {
    const [b] = computeLeaveBalances(base({ joiningDate: '2026-07-01' }));
    expect(b!.entitlementDays).toBe(15);
    // somebody who joins after the year owns nothing that year
    expect(computeLeaveBalances(base({ year: 2025, asOf: '2025-12-31', joiningDate: '2026-07-01' }))[0]!.entitlementDays).toBe(0);
  });
});

describe('monthly accrual', () => {
  const accrual = { ...AL, accrual: 'monthly' as const };
  it('earns the allocation in proportion to the months elapsed, floored to half days', () => {
    const row = { leaveTypeId: 'AL', allocatedDays: 24, carriedForwardDays: 0, carriedForwardExpiresOn: null, openingBalanceDays: 0, adjustmentDays: 0 };
    expect(computeLeaveBalances(base({ types: [accrual], allocations: [row], asOf: '2026-03-31' }))[0]).toMatchObject({ entitlementDays: 24, accruedToDateDays: 6, availableDays: 6 });
    // 16 March: 2 + 16/31 months = 5.03 → 5.0
    expect(computeLeaveBalances(base({ types: [accrual], allocations: [row], asOf: '2026-03-16' }))[0]!.accruedToDateDays).toBe(5);
    // at the end of the year (and for a past year) the whole allocation is earned
    expect(computeLeaveBalances(base({ types: [accrual], allocations: [row], asOf: '2027-02-01' }))[0]!.accruedToDateDays).toBe(24);
  });

  it('prorates from the joining date in the joining year and subtracts what was taken', () => {
    const b = computeLeaveBalances(base({ types: [accrual], joiningDate: '2026-07-01', asOf: '2026-09-30', records: [{ leaveTypeId: 'AL', status: 'APPROVED', startDate: '2026-09-24', endDate: '2026-09-24', isHalfDay: false }] }))[0]!;
    // 30 × 6/12 = 15 for the year; 3 of 6 service months elapsed → 7.5 accrued; 1 taken
    expect(b).toMatchObject({ entitlementDays: 15, accruedToDateDays: 7.5, takenDays: 1, availableDays: 6.5 });
  });

  it('carry-forward, opening balance and adjustment are available at once', () => {
    const b = computeLeaveBalances(base({ types: [accrual], asOf: '2026-01-31', allocations: [{ leaveTypeId: 'AL', allocatedDays: 24, carriedForwardDays: 5, carriedForwardExpiresOn: null, openingBalanceDays: 1, adjustmentDays: 0.5 }] }))[0]!;
    expect(b.accruedToDateDays).toBe(2 + 5 + 1 + 0.5);
  });

  it('accruedToDate helpers', () => {
    expect(monthsInRange('2026-01-01', '2026-12-31')).toBeCloseTo(12, 10);
    expect(monthsInRange('2026-01-15', '2026-01-31')).toBeCloseTo(17 / 31, 10);
    expect(monthsInRange('2026-02-01', '2026-01-31')).toBe(0);
    expect(accruedToDate(24, 2026, null, '2025-12-31')).toBe(0);
    expect(accruedToDate(0, 2026, null, '2026-06-30')).toBe(0);
    expect(serviceStartInYear(2026, '2027-01-01')).toBeNull();
    expect(serviceStartInYear(2026, null)).toBe('2026-01-01');
    expect(clampToYear('2027-05-05', 2026)).toBe('2026-12-31');
  });
});

describe('carry-forward', () => {
  const row = { leaveTypeId: 'AL', allocatedDays: 30, carriedForwardDays: 5, carriedForwardExpiresOn: '2026-03-31', openingBalanceDays: 0, adjustmentDays: 0 };
  it('counts in full until it expires', () => {
    expect(computeLeaveBalances(base({ allocations: [row], asOf: '2026-03-31' }))[0]).toMatchObject({ carriedForwardDays: 5, carriedForwardExpiredDays: 0, entitlementDays: 35 });
  });
  it('after the expiry only the part used before it stays; the rest expires', () => {
    const records = [{ leaveTypeId: 'AL', status: 'APPROVED', startDate: '2026-02-01', endDate: '2026-02-02', isHalfDay: false }, // Sun + Mon = 2
      { leaveTypeId: 'AL', status: 'APPROVED', startDate: '2026-04-05', endDate: '2026-04-06', isHalfDay: false }]; // after expiry
    const b = computeLeaveBalances(base({ allocations: [row], asOf: '2026-09-27', records }))[0]!;
    expect(b).toMatchObject({ carriedForwardDays: 2, carriedForwardExpiredDays: 3, entitlementDays: 32, takenDays: 4, availableDays: 28 });
  });
  it('helpers: capped at the maximum, floored to half days, expiry at month end', () => {
    expect(carryForwardDays(12.7, 10)).toBe(10);
    expect(carryForwardDays(3.7, 10)).toBe(3.5);
    expect(carryForwardDays(-2, 10)).toBe(0);
    expect(carryForwardDays(null, 10)).toBe(0);
    expect(carryForwardDays(8, 0)).toBe(0);
    expect(carryForwardExpiry(2027, 3)).toBe('2027-03-31');
    expect(carryForwardExpiry(2028, 2)).toBe('2028-02-29');
    expect(carryForwardExpiry(2027, null)).toBeNull();
    expect(prorateAllowance(30, 2026, '2026-01-01')).toBe(30);
    // joins 16 Oct: 16/31 + 2 months = 2.516 service months → 30 × 2.516 / 12 = 6.29 → 6.5 (nearest half day)
    expect(prorateAllowance(30, 2026, '2026-10-16')).toBe(6.5);
  });
});

describe('comp-off balance', () => {
  const CO = { leaveTypeId: 'CO', annualAllowanceDays: null, countMode: 'working' as const, accrual: 'none' as const, compOff: true };
  it('earned on approved, unexpired credits minus what they paid for; pending CO requests reserve', () => {
    const b = computeLeaveBalances(base({ types: [CO], asOf: '2026-09-27', credits: [
      { status: 'approved', daysEarned: 1, usedDays: 0, expiresOn: '2026-12-01' },
      { status: 'partially_used', daysEarned: 1, usedDays: 0.5, expiresOn: '2026-10-01' },
      { status: 'used', daysEarned: 0.5, usedDays: 0.5, expiresOn: '2026-11-01' },
      { status: 'expired', daysEarned: 1, usedDays: 0, expiresOn: '2026-09-01' },
      { status: 'approved', daysEarned: 1, usedDays: 0, expiresOn: '2026-09-26' }, // expired yesterday, not yet swept
      { status: 'pending_approval', daysEarned: 1, usedDays: 0, expiresOn: null },
      { status: 'rejected', daysEarned: 1, usedDays: 0, expiresOn: null },
    ], records: [{ leaveTypeId: 'CO', status: 'PENDING', startDate: '2026-10-04', endDate: '2026-10-04', isHalfDay: true }] }))[0]!;
    expect(b).toMatchObject({ tracked: true, entitlementDays: 2.5, takenDays: 1, pendingDays: 0.5, availableDays: 1.5, availableAfterPendingDays: 1 });
  });
});

describe('legacy shape', () => {
  it('leaveBalances keeps the pre-v2 figures', () => {
    const out = leaveBalances([{ leaveTypeId: 'AL', allowanceDays: 30 }, { leaveTypeId: 'SL', allowanceDays: null }], [
      { leaveTypeId: 'AL', status: 'APPROVED', startDate: '2026-08-23', endDate: '2026-08-27', isHalfDay: false },
      { leaveTypeId: 'AL', status: 'PENDING', startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false },
      { leaveTypeId: 'SL', status: 'APPROVED', startDate: '2026-04-07', endDate: '2026-04-08', isHalfDay: false },
    ], cal, 2026);
    expect(out).toEqual([
      { leaveTypeId: 'AL', allowanceDays: 30, usedDays: 5, pendingDays: 5, remainingDays: 20 },
      { leaveTypeId: 'SL', allowanceDays: null, usedDays: 2, pendingDays: 0, remainingDays: null },
    ]);
  });
});
