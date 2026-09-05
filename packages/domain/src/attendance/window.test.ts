import { describe, expect, it } from 'vitest';
import { AppError } from '@flowza/shared';
import { computePunchWindow, crossesMidnight, isWithinWindow, parseInstant, toUtcIso } from './window.js';
import { DATE, MUSCAT, RIYADH, at, fixedShift, flexibleShift, nightShift } from './testing.js';

describe('computePunchWindow', () => {
  it('builds a FIXED day-shift window with the punch-in/out margins', () => {
    const w = computePunchWindow(fixedShift(), DATE, MUSCAT);
    expect(w.kind).toBe('FIXED');
    expect(toUtcIso(w.scheduledStart)).toBe(at(DATE, '09:00'));
    expect(toUtcIso(w.scheduledEnd)).toBe(at(DATE, '17:00'));
    expect(toUtcIso(w.windowStart)).toBe(at(DATE, '05:00'));
    expect(toUtcIso(w.windowEnd)).toBe(at(DATE, '23:00'));
    expect(w.crossesMidnight).toBe(false);
  });

  it('puts the end of a 22:00–06:00 shift on the next day (window 18:00 D → 12:00 D+1)', () => {
    const w = computePunchWindow(nightShift(), DATE, MUSCAT);
    expect(w.crossesMidnight).toBe(true);
    expect(toUtcIso(w.scheduledEnd)).toBe(at('2026-03-11', '06:00'));
    expect(toUtcIso(w.windowStart)).toBe(at(DATE, '18:00'));
    expect(toUtcIso(w.windowEnd)).toBe(at('2026-03-11', '12:00'));
  });

  it('treats endTime equal to startTime as a 24h cross-midnight shift', () => {
    expect(crossesMidnight('08:00', '08:00')).toBe(true);
    expect(crossesMidnight('08:00', '08:01')).toBe(false);
  });

  it('uses the day boundary for FLEXIBLE shifts', () => {
    const w = computePunchWindow(flexibleShift({ dayBoundary: '04:00' }), DATE, MUSCAT);
    expect(w.kind).toBe('FLEXIBLE');
    expect(toUtcIso(w.windowStart)).toBe(at(DATE, '04:00'));
    expect(toUtcIso(w.windowEnd)).toBe(at('2026-03-11', '04:00'));
  });

  it('falls back to the calendar day when there is no shift', () => {
    const w = computePunchWindow(null, DATE, MUSCAT);
    expect(w.kind).toBe('NONE');
    expect(toUtcIso(w.windowStart)).toBe('2026-03-09T20:00:00Z');
    expect(toUtcIso(w.windowEnd)).toBe('2026-03-10T20:00:00Z');
  });

  it('computes different UTC instants for Asia/Muscat and Asia/Riyadh', () => {
    const muscat = computePunchWindow(fixedShift(), DATE, MUSCAT);
    const riyadh = computePunchWindow(fixedShift(), DATE, RIYADH);
    expect(toUtcIso(muscat.scheduledStart)).toBe('2026-03-10T05:00:00Z');
    expect(toUtcIso(riyadh.scheduledStart)).toBe('2026-03-10T06:00:00Z');
  });

  it('handles a DST transition day without hand-computed offsets', () => {
    // Europe/London springs forward on 2026-03-29 (01:00 → 02:00); a 00:30–05:30 shift spans 4 real hours.
    const w = computePunchWindow(fixedShift({ startTime: '00:30', endTime: '05:30' }), '2026-03-29', 'Europe/London');
    expect(w.scheduledEnd.diff(w.scheduledStart, 'hours').hours).toBe(4);
  });

  it('FLEXIBLE windows are half-open: the boundary instant belongs to the next day', () => {
    const w = computePunchWindow(flexibleShift(), DATE, MUSCAT);
    expect(isWithinWindow(w, parseInstant(at(DATE, '04:00'), MUSCAT))).toBe(true);
    expect(isWithinWindow(w, parseInstant(at('2026-03-11', '04:00'), MUSCAT))).toBe(false);
  });

  it('rejects an invalid IANA timezone with a VALIDATION_ERROR', () => {
    expect(() => computePunchWindow(fixedShift(), DATE, 'Mars/Olympus')).toThrowError(AppError);
    try {
      computePunchWindow(fixedShift(), DATE, 'Mars/Olympus');
    } catch (err) {
      expect(AppError.is(err) && err.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects a FIXED shift without times', () => {
    expect(() => computePunchWindow(fixedShift({ startTime: null }), DATE, MUSCAT)).toThrowError(AppError);
  });
});

describe('isWithinWindow boundaries (review)', () => {
  it('FIXED windows include their end instant; FLEXIBLE and calendar windows stay half-open', () => {
    const fixed = computePunchWindow(fixedShift({ punchOutWindowAfterMinutes: 0 }), DATE, MUSCAT);
    expect(isWithinWindow(fixed, parseInstant(at(DATE, '17:00'), MUSCAT))).toBe(true);
    expect(isWithinWindow(fixed, parseInstant(at(DATE, '17:00:01'), MUSCAT))).toBe(false);
    const flex = computePunchWindow(flexibleShift(), DATE, MUSCAT);
    expect(isWithinWindow(flex, parseInstant(at('2026-03-11', '04:00'), MUSCAT))).toBe(false);
    const none = computePunchWindow(null, DATE, MUSCAT);
    expect(isWithinWindow(none, parseInstant(at('2026-03-11', '00:00'), MUSCAT))).toBe(false);
  });
});
