import { describe, expect, it } from 'vitest';
import { neighbourReach, type ReachShift } from './normalize.js';

const flexible = (overrides: Partial<ReachShift> = {}): ReachShift => ({ type: 'FLEXIBLE', startTime: null, endTime: null, dayBoundary: '00:00', punchInWindowBeforeMinutes: 240, punchOutWindowAfterMinutes: 360, requiredMinutes: 480, breaks: [], ...overrides });

describe('neighbourReach', () => {
  it('a flexible night check-out after a 12:00 AM boundary recomputes the previous day (engine 1.3.0 overnight pairing)', () => {
    // 8 h required + 4 h slack after the boundary: a check-out until 12:00 may close yesterday's open check-in
    expect(neighbourReach([flexible()])).toEqual({ previousUntil: 12 * 60, nextFrom: null });
  });

  it('counts the unpaid breaks and the boundary itself, and never reaches past the end of the day', () => {
    expect(neighbourReach([flexible({ dayBoundary: '04:00', breaks: [{ minutes: 60, paid: false }, { minutes: 15, paid: true }] })]).previousUntil).toBe(4 * 60 + 480 + 60 + 240);
    expect(neighbourReach([flexible({ dayBoundary: '12:00', requiredMinutes: 720 })]).previousUntil).toBe(24 * 60 - 1);
  });

  it('keeps the fixed-shift reach: a cross-midnight end or punch-out margin, a punch-in margin before midnight', () => {
    const night: ReachShift = { type: 'FIXED', startTime: '22:00', endTime: '06:00', dayBoundary: '00:00', punchInWindowBeforeMinutes: 240, punchOutWindowAfterMinutes: 360 };
    expect(neighbourReach([night])).toEqual({ previousUntil: 12 * 60, nextFrom: null });
    expect(neighbourReach([{ ...night, startTime: '02:00', endTime: '10:00' }])).toEqual({ previousUntil: null, nextFrom: 22 * 60 });
    expect(neighbourReach([{ ...night, startTime: '09:00', endTime: '17:00' }])).toEqual({ previousUntil: null, nextFrom: null });
  });
});
