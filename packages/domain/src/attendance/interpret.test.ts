import { beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { collapseDuplicates, computeBreaks, interpretPunches, scheduledBreakMinutes } from './interpret.js';
import { DATE, MUSCAT, punch, resetIds } from './testing.js';

const t = (time: string) => DateTime.fromISO(`${DATE}T${time}`, { zone: MUSCAT });
const roles = (r: ReturnType<typeof interpretPunches>) => r.punches.map((p) => p.role);

describe('interpretPunches FIRST_LAST', () => {
  beforeEach(resetIds);

  it('uses the first and last of six punches and ignores the middle four', () => {
    const events = ['09:00', '10:00', '10:30', '13:00', '13:45', '17:00'].map((h) => punch(DATE, h));
    const r = interpretPunches(events, 'FIRST_LAST', MUSCAT);
    expect(roles(r)).toEqual(['IN', 'IGNORED', 'IGNORED', 'IGNORED', 'IGNORED', 'OUT']);
    expect(r.firstIn?.equals(t('09:00'))).toBe(true);
    expect(r.lastOut?.equals(t('17:00'))).toBe(true);
    expect(r.hasMeasuredBreaks).toBe(false);
  });

  it('treats a single punch as IN with OUT missing', () => {
    const r = interpretPunches([punch(DATE, '09:00')], 'FIRST_LAST', MUSCAT);
    expect(r.missingOut).toBe(true);
    expect(r.missingIn).toBe(false);
    expect(r.lastOut).toBeNull();
  });

  it('treats a single directed PUNCH_OUT as OUT with IN missing', () => {
    const r = interpretPunches([punch(DATE, '17:00', 'PUNCH_OUT')], 'FIRST_LAST', MUSCAT);
    expect(r.missingIn).toBe(true);
    expect(r.firstIn).toBeNull();
    expect(r.lastOut?.equals(t('17:00'))).toBe(true);
  });
});

describe('interpretPunches PAIRED', () => {
  beforeEach(resetIds);

  it('pairs punches and measures the gaps as breaks', () => {
    const r = interpretPunches(['09:00', '13:00', '14:00', '18:00'].map((h) => punch(DATE, h)), 'PAIRED', MUSCAT);
    expect(roles(r)).toEqual(['IN', 'OUT', 'IN', 'OUT']);
    expect(r.measuredBreakMinutes).toBe(60);
    expect(r.hasMeasuredBreaks).toBe(true);
    expect(r.missingOut).toBe(false);
  });

  it('flags an odd punch count as missing OUT and keeps the last closed OUT', () => {
    const r = interpretPunches(['09:00', '13:00', '14:00'].map((h) => punch(DATE, h)), 'PAIRED', MUSCAT);
    expect(r.missingOut).toBe(true);
    expect(r.lastOut?.equals(t('13:00'))).toBe(true);
    expect(r.segments).toHaveLength(2);
  });
});

describe('interpretPunches DIRECTIONAL', () => {
  beforeEach(resetIds);

  it('trusts device directions including break events', () => {
    const events = [punch(DATE, '09:00', 'PUNCH_IN'), punch(DATE, '13:00', 'BREAK_START'), punch(DATE, '13:45', 'BREAK_END'), punch(DATE, '17:00', 'PUNCH_OUT')];
    const r = interpretPunches(events, 'DIRECTIONAL', MUSCAT);
    expect(roles(r)).toEqual(['IN', 'BREAK_START', 'BREAK_END', 'OUT']);
    expect(r.measuredBreakMinutes).toBe(45);
    expect(r.firstIn?.equals(t('09:00'))).toBe(true);
    expect(r.lastOut?.equals(t('17:00'))).toBe(true);
    expect(r.missingOut).toBe(false);
  });

  it('ignores repeated directions and detects a missing OUT', () => {
    const events = [punch(DATE, '09:00', 'PUNCH_IN'), punch(DATE, '09:30', 'PUNCH_IN')];
    const r = interpretPunches(events, 'DIRECTIONAL', MUSCAT);
    expect(roles(r)).toEqual(['IN', 'IGNORED']);
    expect(r.missingOut).toBe(true);
  });

  it('marks an OUT without any IN as missing IN', () => {
    const r = interpretPunches([punch(DATE, '17:00', 'PUNCH_OUT')], 'DIRECTIONAL', MUSCAT);
    expect(r.missingIn).toBe(true);
    expect(r.lastOut?.equals(t('17:00'))).toBe(true);
    expect(r.firstIn).toBeNull();
  });

  it('falls back to PAIRED when no punch carries a direction', () => {
    const r = interpretPunches(['09:00', '17:00'].map((h) => punch(DATE, h)), 'DIRECTIONAL', MUSCAT);
    expect(r.mode).toBe('DIRECTIONAL');
    expect(r.effectiveMode).toBe('PAIRED');
    expect(roles(r)).toEqual(['IN', 'OUT']);
  });

  it('lets an undirected PUNCH toggle the state when mixed with directed punches', () => {
    const events = [punch(DATE, '09:00', 'PUNCH_IN'), punch(DATE, '17:00', 'PUNCH')];
    const r = interpretPunches(events, 'DIRECTIONAL', MUSCAT);
    expect(roles(r)).toEqual(['IN', 'OUT']);
  });
});

describe('collapseDuplicates', () => {
  beforeEach(resetIds);

  it('keeps the first of repeated punches inside the window', () => {
    const first = punch(DATE, '09:00:00');
    const dup = punch(DATE, '09:00:30');
    const later = punch(DATE, '09:01:31');
    const { kept, duplicates } = collapseDuplicates([later, dup, first], 60);
    expect(kept.map((e) => e.id)).toEqual([first.id, later.id]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.event.id).toBe(dup.id);
    expect(duplicates[0]?.of.id).toBe(first.id);
    expect(duplicates[0]?.secondsApart).toBe(30);
  });

  it('does not collapse an IN followed by a directed OUT', () => {
    const { kept } = collapseDuplicates([punch(DATE, '09:00:00', 'PUNCH_IN'), punch(DATE, '09:00:20', 'PUNCH_OUT')], 60);
    expect(kept).toHaveLength(2);
  });

  it('is disabled when the window is 0', () => {
    const { kept } = collapseDuplicates([punch(DATE, '09:00:00'), punch(DATE, '09:00:01')], 0);
    expect(kept).toHaveLength(2);
  });
});

describe('breaks', () => {
  const base = { attendanceDate: DATE, zone: MUSCAT, crossesMidnight: false, interpretation: { measuredBreakMinutes: 0, hasMeasuredBreaks: false } };

  it('sums scheduled break minutes by paid flag', () => {
    expect(scheduledBreakMinutes([{ minutes: 30, paid: false }, { start: '13:00', end: '14:00', paid: false }, { minutes: 15, paid: true }])).toEqual({ paid: 15, unpaid: 90 });
  });

  it('deducts fixed unpaid minutes but not paid ones', () => {
    const r = computeBreaks({ ...base, breaks: [{ minutes: 30, paid: false }, { minutes: 15, paid: true }], firstIn: t('09:00'), lastOut: t('17:00') });
    expect(r).toMatchObject({ unpaidMinutes: 30, paidMinutes: 15, source: 'FIXED' });
  });

  it('deducts a scheduled range only where it overlaps the worked span', () => {
    const lunch = [{ start: '13:00', end: '14:00', paid: false }];
    expect(computeBreaks({ ...base, breaks: lunch, firstIn: t('09:00'), lastOut: t('17:00') }).unpaidMinutes).toBe(60);
    expect(computeBreaks({ ...base, breaks: lunch, firstIn: t('09:00'), lastOut: t('13:30') }).unpaidMinutes).toBe(30);
    expect(computeBreaks({ ...base, breaks: lunch, firstIn: t('09:00'), lastOut: t('12:00') }).unpaidMinutes).toBe(0);
  });

  it('prefers measured breaks and credits paid allowances back', () => {
    const r = computeBreaks({ ...base, interpretation: { measuredBreakMinutes: 45, hasMeasuredBreaks: true }, breaks: [{ minutes: 30, paid: true }, { minutes: 60, paid: false }], firstIn: t('09:00'), lastOut: t('17:00') });
    expect(r).toMatchObject({ unpaidMinutes: 15, paidMinutes: 30, source: 'MEASURED' });
  });

  it('returns nothing without a worked span', () => {
    expect(computeBreaks({ ...base, breaks: [{ minutes: 30, paid: false }], firstIn: t('09:00'), lastOut: null }).source).toBe('NONE');
  });
});

describe('interpretPunches DIRECTIONAL orphan OUT (review)', () => {
  beforeEach(resetIds);

  it('does not report an orphan OUT as lastOut when a later IN opened a segment', () => {
    const r = interpretPunches([punch(DATE, '08:00', 'PUNCH_OUT'), punch(DATE, '09:00', 'PUNCH_IN')], 'DIRECTIONAL', MUSCAT);
    expect(r.missingIn).toBe(true);
    expect(r.missingOut).toBe(true);
    expect(r.lastOut).toBeNull();
    expect(r.firstIn?.equals(t('09:00'))).toBe(true);
  });
});
