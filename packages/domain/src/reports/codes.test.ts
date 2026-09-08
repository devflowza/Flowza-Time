import { describe, expect, it } from 'vitest';
import { legendItems, resolveAttendanceCode } from './codes.js';

describe('resolveAttendanceCode', () => {
  it('maps statuses onto the two-letter codes of the samples', () => {
    expect(resolveAttendanceCode({ status: 'PRESENT', flags: [] })).toEqual({ code: 'PR', group: 'present' });
    expect(resolveAttendanceCode({ status: 'ABSENT', flags: [] })).toEqual({ code: 'AB', group: 'absent' });
    expect(resolveAttendanceCode({ status: 'WEEKLY_OFF', flags: [] })).toEqual({ code: 'OF', group: 'off' });
    expect(resolveAttendanceCode({ status: 'HOLIDAY', flags: [] })).toEqual({ code: 'HL', group: 'holiday' });
    expect(resolveAttendanceCode({ status: 'HALF_DAY', flags: [] })).toEqual({ code: 'HDP', group: 'present' });
    // a day with a missing punch is still a present day; the report shows the punch that exists
    expect(resolveAttendanceCode({ status: 'MISSING_PUNCH', flags: ['MISSING_OUT'] })).toEqual({ code: 'PR', group: 'present' });
    expect(resolveAttendanceCode({ status: 'PENDING', flags: [] })).toEqual({ code: '', group: 'none' });
  });
  it("uses the tenant's leave-type code and lets its flags decide the totals group", () => {
    expect(resolveAttendanceCode({ status: 'LEAVE', flags: [], leaveTypeCode: 'AL', leaveIsPaid: true })).toEqual({ code: 'AL', group: 'leave' });
    // no-pay leave counts with absences (T/AB), as the Summary sample does with NP
    expect(resolveAttendanceCode({ status: 'LEAVE', flags: [], leaveTypeCode: 'NP', leaveIsPaid: false })).toEqual({ code: 'NP', group: 'absent' });
    // site duty is a paid present day (T/PR)
    expect(resolveAttendanceCode({ status: 'LEAVE', flags: [], leaveTypeCode: 'SD', leaveIsPaid: true, leaveTreatAsPresent: true })).toEqual({ code: 'SD', group: 'present' });
    // a leave record that can no longer be found falls back to the generic code
    expect(resolveAttendanceCode({ status: 'LEAVE', flags: [] })).toEqual({ code: 'LV', group: 'leave' });
  });
  it('shows half-day leave as HDL regardless of how the other half went', () => {
    expect(resolveAttendanceCode({ status: 'HALF_DAY', flags: ['HALF_DAY_LEAVE'] })).toEqual({ code: 'HDL', group: 'leave' });
    expect(resolveAttendanceCode({ status: 'PRESENT', flags: ['HALF_DAY_LEAVE'] }).code).toBe('HDL');
  });
  it('honours per-tenant overrides for status codes only', () => {
    const o = { PRESENT: 'P', HALF_DAY_LEAVE: 'HL2', LEAVE: 'L' };
    expect(resolveAttendanceCode({ status: 'PRESENT', flags: [] }, o).code).toBe('P');
    expect(resolveAttendanceCode({ status: 'HALF_DAY', flags: ['HALF_DAY_LEAVE'] }, o).code).toBe('HL2');
    expect(resolveAttendanceCode({ status: 'LEAVE', flags: [] }, o).code).toBe('L');
    expect(resolveAttendanceCode({ status: 'LEAVE', flags: [], leaveTypeCode: 'SL' }, o).code).toBe('SL');
  });
});

describe('legendItems', () => {
  it("lists presence codes, then the tenant's leave types, then the half-day codes", () => {
    const items = legendItems([{ code: 'AL', name: 'Annual Leave', isPaid: true }, { code: 'SL', name: 'Sick Leave', nameAr: 'إجازة مرضية', isPaid: true }], 'en');
    expect(items.map((i) => i.code)).toEqual(['PR', 'AB', 'OF', 'HL', 'AL', 'SL', 'HDP', 'HDL']);
    expect(items[4]).toEqual({ code: 'AL', labelKey: null, label: 'Annual Leave' });
    expect(legendItems([{ code: 'SL', name: 'Sick Leave', nameAr: 'إجازة مرضية', isPaid: true }], 'ar')[4]!.label).toBe('إجازة مرضية');
  });
});
