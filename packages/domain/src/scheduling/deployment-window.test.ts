import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_CHECKOUT_GRACE_UNTIL_HOUR, deploymentAccessExpired, deploymentAcceptsHostFences, deploymentCoverageAt, deploymentStarted, hostLocalTime } from './deployment-window.js';

/* The window of a temporary branch deployment, in the HOST branch's time (docs/enterprise/plan.md §4.7). */
const range = { fromDate: '2026-12-01', toDate: '2026-12-07' };
const at = (date: string, hhmm: string) => ({ date, minuteOfDay: Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) });

describe('deployment window', () => {
  it('covers fromDate through toDate, then the morning after until noon (a night shift\'s check-out)', () => {
    expect(DEPLOYMENT_CHECKOUT_GRACE_UNTIL_HOUR).toBe(12);
    expect(deploymentCoverageAt(range, at('2026-11-30', '23:59'))).toBe('before');
    expect(deploymentCoverageAt(range, at('2026-12-01', '00:00'))).toBe('active');
    expect(deploymentCoverageAt(range, at('2026-12-07', '22:00'))).toBe('active');
    expect(deploymentCoverageAt(range, at('2026-12-08', '06:05'))).toBe('checkout_grace');
    expect(deploymentCoverageAt(range, at('2026-12-08', '11:59'))).toBe('checkout_grace');
    expect(deploymentCoverageAt(range, at('2026-12-08', '12:00'))).toBe('after');
    expect(deploymentCoverageAt(range, at('2026-12-09', '06:00'))).toBe('after');
    expect(deploymentAcceptsHostFences(range, at('2026-12-08', '06:05'))).toBe(true);
    expect(deploymentAcceptsHostFences(range, at('2026-12-08', '15:00'))).toBe(false);
    expect(deploymentAcceptsHostFences(range, at('2026-11-30', '12:00'))).toBe(false);
  });

  it('enrols from the first day to the last; takes the terminals away once the host date is toDate + 2', () => {
    expect(deploymentStarted(range, '2026-11-30')).toBe(false);
    expect(deploymentStarted(range, '2026-12-01')).toBe(true);
    expect(deploymentStarted(range, '2026-12-07')).toBe(true);
    expect(deploymentStarted(range, '2026-12-08')).toBe(false);
    expect(deploymentAccessExpired('2026-12-07', '2026-12-07')).toBe(false);
    expect(deploymentAccessExpired('2026-12-07', '2026-12-08')).toBe(false);
    expect(deploymentAccessExpired('2026-12-07', '2026-12-09')).toBe(true);
    // month boundary
    expect(deploymentAccessExpired('2026-12-31', '2027-01-02')).toBe(true);
    expect(deploymentAccessExpired('2026-12-31', '2027-01-01')).toBe(false);
  });

  it('reads the host\'s local time with Luxon (UTC for an unknown zone)', () => {
    // 2026-12-07T20:30Z is 00:30 on the 8th in Muscat (UTC+4) and still the 7th in Riyadh (UTC+3)
    const instant = new Date('2026-12-07T20:30:00Z');
    expect(hostLocalTime(instant, 'Asia/Muscat')).toEqual({ date: '2026-12-08', minuteOfDay: 30 });
    expect(hostLocalTime(instant, 'Asia/Riyadh')).toEqual({ date: '2026-12-07', minuteOfDay: 23 * 60 + 30 });
    expect(hostLocalTime(instant, 'Not/AZone')).toEqual({ date: '2026-12-07', minuteOfDay: 20 * 60 + 30 });
  });
});
