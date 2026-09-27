import { describe, expect, it } from 'vitest';
import { balanceShares, fmtDays, monthWeeks, previewLeaveDays, shiftMonth, tenure, validMonth, weekdayOrder } from './model';

const cal = { weeklyOffDays: [5, 6], holidays: new Set(['2026-09-29']) };

describe('portal model', () => {
  it('previews working days like the server (weekly offs and holidays are free)', () => {
    expect(previewLeaveDays('2026-09-24', '2026-09-30', false, cal)).toBe(4);
    expect(previewLeaveDays('2026-09-24', '2026-09-24', true, cal)).toBe(0.5);
    expect(previewLeaveDays('2026-09-30', '2026-09-24', false, cal)).toBe(0);
  });

  it('lays a month out in weeks from the configured first day', () => {
    // September 2026 starts on a Tuesday
    const sunday = monthWeeks('2026-09', 0);
    expect(sunday[0]).toEqual([null, null, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
    expect(sunday.flat().filter(Boolean)).toHaveLength(30);
    expect(sunday.every((w) => w.length === 7)).toBe(true);
    const saturday = monthWeeks('2026-09', 6);
    expect(saturday[0]?.slice(0, 4)).toEqual([null, null, null, '2026-09-01']);
    expect(weekdayOrder(6)).toEqual([6, 0, 1, 2, 3, 4, 5]);
  });

  it('moves between months and validates URL input', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(validMonth('2026-13', '2026-09')).toBe('2026-09');
    expect(validMonth('2026-02', '2026-09')).toBe('2026-02');
  });

  it('splits a balance bar into used and pending shares', () => {
    expect(balanceShares({ allowanceDays: 30, usedDays: 15, pendingDays: 3 })).toEqual({ used: 0.5, pending: 0.1 });
    expect(balanceShares({ allowanceDays: 10, usedDays: 12, pendingDays: 2 })).toEqual({ used: 1, pending: 0 });
    expect(balanceShares({ allowanceDays: null, usedDays: 2, pendingDays: 0 })).toBeNull();
  });

  it('computes tenure and formats days', () => {
    expect(tenure('2022-05-15', '2026-09-27')).toEqual({ years: 4, months: 4 });
    expect(fmtDays(2)).toBe('2');
    expect(fmtDays(2.5)).toBe('2.5');
  });
});
