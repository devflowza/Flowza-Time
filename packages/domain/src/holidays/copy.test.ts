import { describe, expect, it } from 'vitest';
import { branchScopesOverlap, planHolidayYearCopy, sameDayInYear, type CopyableHoliday } from './copy.js';

const h = (over: Partial<CopyableHoliday> & { id: string; date: string }): CopyableHoliday => ({ name: over.id, endDate: null, branchIds: null, recursYearly: true, isTentative: false, ...over });

describe('holiday year copy (pure plan)', () => {
  it('same day and month; 29 February → 28 February outside a leap year', () => {
    expect(sameDayInYear('2026-11-18', 2027)).toBe('2027-11-18');
    expect(sameDayInYear('2028-02-29', 2029)).toBe('2029-02-28');
    expect(sameDayInYear('2028-02-29', 2032)).toBe('2032-02-29');
  });

  it('branch scopes overlap when either is organisation-wide or they share a branch', () => {
    expect(branchScopesOverlap(null, ['b1'])).toBe(true);
    expect(branchScopesOverlap([], ['b1'])).toBe(true);
    expect(branchScopesOverlap(['b1', 'b2'], ['b2'])).toBe(true);
    expect(branchScopesOverlap(['b1'], ['b2'])).toBe(false);
  });

  it('copies recurring holidays, skips the others unless asked (then tentative), and only the source year', () => {
    const source = [h({ id: 'nd', date: '2026-11-18', endDate: '2026-11-19' }), h({ id: 'eid', date: '2026-03-20', recursYearly: false }), h({ id: 'old', date: '2025-01-01' })];
    const plan = planHolidayYearCopy(source, [], 2026, 2027, { includeNonRecurring: false });
    expect(plan.create.map((c) => [c.source.id, c.date, c.endDate, c.isTentative])).toEqual([['nd', '2027-11-18', '2027-11-19', false]]);
    expect(plan.skipped).toEqual([{ sourceId: 'eid', name: 'eid', date: '2026-03-20', reason: 'NOT_RECURRING' }]);
    expect(plan.rolledOver).toEqual(['nd']);
    const all = planHolidayYearCopy(source, [], 2026, 2027, { includeNonRecurring: true });
    expect(all.create.map((c) => [c.source.id, c.date, c.isTentative])).toEqual([['eid', '2027-03-20', true], ['nd', '2027-11-18', false]]);
    expect(all.rolledOver).toEqual(['nd']); // only recurring holidays enter the rollover ledger
  });

  it('skips a date the target year already has for overlapping branches (and its own duplicates); a year-end holiday keeps its length', () => {
    const source = [h({ id: 'a', date: '2026-07-23', branchIds: ['b1'] }), h({ id: 'b', date: '2026-07-23', branchIds: ['b2'] }), h({ id: 'c', date: '2026-07-23' }), h({ id: 'ny', date: '2026-12-31', endDate: '2027-01-01' })];
    const plan = planHolidayYearCopy(source, [h({ id: 'x', date: '2027-07-23', branchIds: ['b1'] })], 2026, 2027, { includeNonRecurring: false });
    expect(plan.create.map((c) => [c.source.id, c.date, c.endDate])).toEqual([['b', '2027-07-23', null], ['ny', '2027-12-31', '2028-01-01']]);
    expect(plan.skipped.map((s) => [s.sourceId, s.reason])).toEqual([['a', 'ALREADY_THERE'], ['c', 'ALREADY_THERE']]);
    expect(plan.rolledOver).toEqual(['a', 'b', 'c', 'ny']);
  });
});
