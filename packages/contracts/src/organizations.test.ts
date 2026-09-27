import { describe, expect, it } from 'vitest';
import { attendanceSettingsSchema, DEFAULT_ATTENDANCE_SETTINGS, organizationSettingsSchema, resolveAttendanceSettings } from './organizations.js';

/**
 * `organization_settings.attendance` (HR portal Prompt 3). The API stores the whole group (`PUT /settings/attendance`)
 * after `organizationSettingsSchema.shape.attendance.parse(payload)`, and reads it back through the same schema, so
 * these tests pin the two things that matter: a missing key resolves to its documented default (a row saved before the
 * key existed keeps working), and a full document round-trips unchanged (the Zod 4 "partial re-applies defaults" trap
 * never resets a value that was sent).
 */
describe('attendance settings', () => {
  it('fills every default for an empty / absent group', () => {
    const fromGroup = organizationSettingsSchema.shape.attendance.parse({});
    expect(fromGroup).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
    expect(resolveAttendanceSettings(null)).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
    expect(resolveAttendanceSettings(undefined)).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
    expect(DEFAULT_ATTENDANCE_SETTINGS).toMatchObject({
      processingDelaySeconds: 30, payrollPeriod: 'calendar_month', payrollCutoffDay: 25, allowSelfServiceCorrections: false,
      selfService: { webCheckIn: false, mobileCheckIn: false, requireGeofence: 'flag', allowSelfieCheckIn: false, ipAllowList: [], checkInWindow: null, checkOutWindow: null, outOfWindowAction: 'flag', duplicatePunchSeconds: 60 },
      missedPunch: { detectionEnabled: true, dayCloseGraceDays: 2, singlePunchSplitTime: '12:00' },
      nonWorkingDay: { action: 'record' },
      unexcused: { autoDeductEnabled: false, graceDays: 3, payEffectAbsent: 1, payEffectLate: 0.5, payEffectMissingPunch: 0.5, leaveTypePriority: ['AL', 'CL'], excludeLeaveTypeCodes: ['SL', 'ML', 'PTL', 'HJ'] },
      notes: { requireReasonForLate: false, requireReasonForAbsent: false },
      stats: { attendanceTargetPct: 90, fullDayHours: 8 },
    });
    // the whole-settings document (what /me carries) resolves the group the same way
    expect(organizationSettingsSchema.parse({ attendance: {} }).attendance).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
  });

  it('keeps the pre-existing keys and their defaults (nothing removed)', () => {
    const legacy = { defaultShiftId: '11111111-1111-1111-1111-111111111111', processingDelaySeconds: 5, payrollPeriod: 'custom_cutoff', payrollCutoffDay: 20, allowSelfServiceCorrections: true };
    const parsed = organizationSettingsSchema.shape.attendance.parse(legacy);
    expect(parsed).toMatchObject(legacy);
    expect(parsed.selfService).toEqual(DEFAULT_ATTENDANCE_SETTINGS.selfService); // a row saved before the group existed
  });

  it('round-trips a full non-default document without re-applying any default (the PATCH / partial trap)', () => {
    const full = attendanceSettingsSchema.parse({
      defaultShiftId: null, processingDelaySeconds: 120, payrollPeriod: 'custom_cutoff', payrollCutoffDay: 21, allowSelfServiceCorrections: true,
      selfService: { webCheckIn: true, mobileCheckIn: true, requireGeofence: 'block', allowSelfieCheckIn: true, ipAllowList: ['10.0.0.0/8', '192.168.1.5', '2001:db8::/32'], checkInWindow: { start: '06:00', end: '12:00' }, checkOutWindow: { start: '12:00', end: '23:00' }, outOfWindowAction: 'reject', duplicatePunchSeconds: 120 },
      missedPunch: { detectionEnabled: false, dayCloseGraceDays: 5, singlePunchSplitTime: '13:30' },
      nonWorkingDay: { action: 'overtime' },
      unexcused: { autoDeductEnabled: true, graceDays: 10, payEffectAbsent: 0.5, payEffectLate: 0, payEffectMissingPunch: 1, leaveTypePriority: ['cl', 'AL'], excludeLeaveTypeCodes: ['sl'] },
      notes: { requireReasonForLate: true, requireReasonForAbsent: true },
      stats: { attendanceTargetPct: 95, fullDayHours: 9 },
    });
    expect(full.unexcused.leaveTypePriority).toEqual(['CL', 'AL']); // codes are normalised once, to upper case
    expect(full.unexcused.excludeLeaveTypeCodes).toEqual(['SL']);
    // the stored group is the partial schema: parsing what was stored gives back exactly what was stored
    const stored = organizationSettingsSchema.shape.attendance.parse(full);
    expect(stored).toEqual(full);
    expect(resolveAttendanceSettings(stored)).toEqual(full);
    // a single nested key on its own leaves its siblings at the defaults, never undefined
    const one = organizationSettingsSchema.shape.attendance.parse({ selfService: { webCheckIn: true } });
    expect(one.selfService).toEqual({ ...DEFAULT_ATTENDANCE_SETTINGS.selfService, webCheckIn: true });
    expect(one.unexcused).toEqual(DEFAULT_ATTENDANCE_SETTINGS.unexcused);
  });

  it('rejects out-of-range values instead of clamping them', () => {
    const group = organizationSettingsSchema.shape.attendance;
    expect(group.safeParse({ missedPunch: { dayCloseGraceDays: 8 } }).success).toBe(false);
    expect(group.safeParse({ unexcused: { graceDays: 31 } }).success).toBe(false);
    expect(group.safeParse({ unexcused: { payEffectAbsent: 0.75 } }).success).toBe(false);
    expect(group.safeParse({ selfService: { ipAllowList: ['not-an-ip'] } }).success).toBe(false);
    expect(group.safeParse({ selfService: { checkInWindow: { start: '25:00', end: '12:00' } } }).success).toBe(false);
    expect(group.safeParse({ nonWorkingDay: { action: 'block' } }).success).toBe(false);
    expect(group.safeParse({ stats: { fullDayHours: 0 } }).success).toBe(false);
  });

  it('falls back to the defaults for an unparseable stored value instead of throwing', () => {
    expect(resolveAttendanceSettings({ unexcused: { graceDays: 'many' } })).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
    expect(resolveAttendanceSettings('garbage')).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
  });
});
