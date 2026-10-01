import { describe, expect, it } from 'vitest';
import { dayBoundaryGuide, flexibleGuide, joinMinutes, splitMinutes } from './flexible-guide';

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

describe('dayBoundaryGuide — which day the sample night (Mon 20:00 → Tue 03:00) lands on', () => {
  it('keeps the night on Monday when the boundary falls after the check-out and before the check-in', () => {
    expect(dayBoundaryGuide('04:00')).toEqual({ boundary: '04:00', last: '03:59', lastDay: 'tue', inDay: 'mon', outDay: 'mon', split: false });
    expect(dayBoundaryGuide('12:00')).toMatchObject({ last: '11:59', inDay: 'mon', outDay: 'mon', split: false });
    expect(dayBoundaryGuide('03:01')).toMatchObject({ split: false });
  });

  it('flags a boundary that splits the night across two days', () => {
    expect(dayBoundaryGuide('00:00')).toEqual({ boundary: '00:00', last: '23:59', lastDay: 'mon', inDay: 'mon', outDay: 'tue', split: true });
    expect(dayBoundaryGuide('03:00')).toMatchObject({ inDay: 'mon', outDay: 'tue', split: true }); // a punch AT the boundary starts the new day
    expect(dayBoundaryGuide('21:00')).toMatchObject({ inDay: 'sun', outDay: 'mon', split: true });
  });

  it('says nothing for a missing or malformed boundary', () => {
    expect(dayBoundaryGuide(undefined)).toBeNull();
    expect(dayBoundaryGuide('')).toBeNull();
    expect(dayBoundaryGuide('4am')).toBeNull();
  });
});

describe('required time as hours + minutes', () => {
  it('splits and joins minutes', () => {
    expect(splitMinutes(480)).toEqual({ hours: '8', minutes: '0' });
    expect(splitMinutes(450)).toEqual({ hours: '7', minutes: '30' });
    expect(splitMinutes(undefined)).toEqual({ hours: '', minutes: '' });
    expect(joinMinutes('8', '')).toBe(480);
    expect(joinMinutes('', '45')).toBe(45);
    expect(joinMinutes('7', '30')).toBe(450);
    expect(joinMinutes('7.5', '')).toBe(450);
    expect(joinMinutes('', '')).toBeUndefined();
  });
});
