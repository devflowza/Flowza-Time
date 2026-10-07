import { describe, expect, it } from 'vitest';
import { attendancePolicySectionsSchema } from '@flowza/contracts';
import { CHECKIN_METHOD_NOT_ALLOWED, checkInMethodRefusal, effectiveGeofenceRequirement, REGULARISATION_MONTHLY_LIMIT, REGULARISATION_TOO_OLD, regularisationRefusal } from './enforcement.js';

const sections = (over: Record<string, unknown> = {}) => attendancePolicySectionsSchema.parse(over);

describe('policy enforcement helpers for the self-service endpoints', () => {
  it('check-in methods: the defaults allow every method; a policy can switch one off', () => {
    for (const m of ['web', 'mobile', 'selfie'] as const) expect(checkInMethodRefusal(sections(), m)).toBeNull();
    const err = checkInMethodRefusal(sections({ methods: { mobile: false } }), 'mobile');
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.details).toEqual({ reason: CHECKIN_METHOD_NOT_ALLOWED, method: 'mobile' });
    expect(checkInMethodRefusal(sections({ methods: { mobile: false } }), 'web')).toBeNull();
  });

  it('geofence: inherit takes the organisation setting, anything else overrides it', () => {
    expect(effectiveGeofenceRequirement(sections(), 'flag')).toBe('flag');
    expect(effectiveGeofenceRequirement(sections({ methods: { requireGeofence: 'block' } }), 'off')).toBe('block');
    expect(effectiveGeofenceRequirement(sections({ methods: { requireGeofence: 'off' } }), 'block')).toBe('off');
  });

  it('regularisation: how far back and how many a month', () => {
    const limited = sections({ regularisation: { maxPerMonth: 2, backdateDays: 7 } });
    expect(regularisationRefusal(sections(), { date: '2020-01-01', today: '2026-10-07', requestsInMonth: 99 })).toBeNull();
    expect(regularisationRefusal(limited, { date: '2026-09-30', today: '2026-10-07', requestsInMonth: 0 })).toBeNull(); // exactly 7 days back
    expect(regularisationRefusal(limited, { date: '2026-09-29', today: '2026-10-07', requestsInMonth: 0 })?.details).toMatchObject({ reason: REGULARISATION_TOO_OLD });
    expect(regularisationRefusal(limited, { date: '2026-10-06', today: '2026-10-07', requestsInMonth: 1 })).toBeNull();
    const full = regularisationRefusal(limited, { date: '2026-10-06', today: '2026-10-07', requestsInMonth: 2 });
    expect(full?.code).toBe('VALIDATION_ERROR');
    expect(full?.details).toMatchObject({ reason: REGULARISATION_MONTHLY_LIMIT, maxPerMonth: 2 });
  });
});
