import { describe, expect, it } from 'vitest';
import { flexibleGuide } from './flexible-guide';

describe('flexibleGuide — the flexible shift rule in the author\'s numbers', () => {
  it('shows the check-out as check-in + required minutes + unpaid breaks', () => {
    expect(flexibleGuide(480, undefined, undefined, []).example).toEqual({ in: '09:00', out: '17:00' });
    expect(flexibleGuide(480, undefined, undefined, [{ minutes: 60, paid: false }, { minutes: 15, paid: true }]).example).toEqual({ in: '09:00', out: '18:00' });
    expect(flexibleGuide(480, '19:00', undefined, [{ start: '23:00', end: '23:30', paid: false }]).example).toEqual({ in: '19:00', out: '03:30' });
  });

  it('warns when the core hours are longer than the required time (people would have to stay until the core end)', () => {
    // the 17:00–04:00 core of an 8-hour flexible shift: 11 hours of mandatory presence
    expect(flexibleGuide(480, '17:00', '04:00', [{ minutes: 1, paid: true }]).coreTooLong).toEqual({ core: '11h 00m', required: '8h 00m' });
    expect(flexibleGuide(480, '10:00', '15:00', []).coreTooLong).toBeNull();
    expect(flexibleGuide(480, undefined, undefined, []).coreTooLong).toBeNull();
  });

  it('says nothing until the required minutes are known', () => {
    expect(flexibleGuide(undefined, '10:00', '15:00', [])).toEqual({ example: null, coreTooLong: null });
  });
});
