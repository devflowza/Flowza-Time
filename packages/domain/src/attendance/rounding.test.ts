import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { roundInstant, roundMinutes, roundPunches } from './rounding.js';
import { MUSCAT } from './testing.js';

describe('roundMinutes', () => {
  it.each([
    [67, 15, 'NEAREST', 60],
    [68, 15, 'NEAREST', 75],
    [67, 15, 'UP', 75],
    [67, 15, 'DOWN', 60],
    [60, 15, 'UP', 60],
    [67, 15, 'NONE', 67],
    [67, 0, 'UP', 67],
    [-7, 5, 'UP', -5],
    [-7, 5, 'DOWN', -10],
  ] as const)('rounds %i by %i %s → %i', (value, interval, mode, expected) => {
    expect(roundMinutes(value, interval, mode)).toBe(expected);
  });
});

describe('roundInstant', () => {
  const t = (time: string) => DateTime.fromISO(`2026-03-10T${time}`, { zone: MUSCAT });

  it('rounds from local midnight so wall-clock boundaries are respected', () => {
    expect(roundInstant(t('08:52:00'), 15, 'NEAREST').toFormat('HH:mm')).toBe('08:45');
    expect(roundInstant(t('08:53:00'), 15, 'NEAREST').toFormat('HH:mm')).toBe('09:00');
    expect(roundInstant(t('08:52:00'), 15, 'UP').toFormat('HH:mm')).toBe('09:00');
    expect(roundInstant(t('08:52:00'), 15, 'DOWN').toFormat('HH:mm')).toBe('08:45');
  });

  it('folds seconds into the fractional minute', () => {
    expect(roundInstant(t('10:07:30'), 15, 'NEAREST').toFormat('HH:mm')).toBe('10:15');
    expect(roundInstant(t('10:07:29'), 15, 'NEAREST').toFormat('HH:mm')).toBe('10:00');
    expect(roundInstant(t('10:00:01'), 15, 'UP').toFormat('HH:mm')).toBe('10:15');
  });

  it('respects non-hour offsets (Asia/Kathmandu +05:45)', () => {
    const k = DateTime.fromISO('2026-03-10T09:20:00', { zone: 'Asia/Kathmandu' });
    expect(roundInstant(k, 30, 'NEAREST').toFormat('HH:mm')).toBe('09:30');
  });

  it('returns the instant unchanged for NONE or interval 0', () => {
    expect(roundInstant(t('08:52:00'), 15, 'NONE').equals(t('08:52:00'))).toBe(true);
    expect(roundInstant(t('08:52:00'), 0, 'UP').equals(t('08:52:00'))).toBe(true);
  });
});

describe('roundPunches', () => {
  const t = (time: string) => DateTime.fromISO(`2026-03-10T${time}`, { zone: MUSCAT });

  it('rounds both punches with the same mode and reports whether anything changed', () => {
    const r = roundPunches(t('08:52'), t('17:08'), 15, 'NEAREST');
    expect(r.firstIn?.toFormat('HH:mm')).toBe('08:45');
    expect(r.lastOut?.toFormat('HH:mm')).toBe('17:15');
    expect(r.changed).toBe(true);
  });

  it('handles missing punches and unchanged values', () => {
    const r = roundPunches(t('09:00'), null, 15, 'NEAREST');
    expect(r.lastOut).toBeNull();
    expect(r.changed).toBe(false);
  });
});
