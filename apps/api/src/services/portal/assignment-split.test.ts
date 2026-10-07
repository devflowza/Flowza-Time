import { describe, expect, it } from 'vitest';
import { addDays } from '@flowza/shared';
import { planRangeSplit, runsOf } from './assignment-split.js';

/** The pure part of the range placement (shift change requests): which rows are deleted, trimmed or split around [from, to). */
describe('planRangeSplit', () => {
  const from = '2026-10-10'; const to = '2026-10-15'; // the range [10, 15)

  it('leaves rows that do not overlap the range alone (half-open bounds touch, they do not overlap)', () => {
    expect(planRangeSplit([{ id: 'a', from: '2026-01-01', to: from }, { id: 'b', from: to, to: null }, { id: 'c', from: '2026-11-01', to: '2026-11-05' }], from, to)).toEqual([]);
  });

  it('deletes a row inside the range, including one with exactly the same bounds', () => {
    expect(planRangeSplit([{ id: 'a', from, to }, { id: 'b', from: '2026-10-11', to: '2026-10-12' }], from, to)).toEqual([
      { kind: 'delete', id: 'a', from, to },
      { kind: 'delete', id: 'b', from: '2026-10-11', to: '2026-10-12' },
    ]);
  });

  it('trims a row that ends inside the range and one that starts inside it', () => {
    expect(planRangeSplit([{ id: 'a', from: '2026-01-01', to: '2026-10-12' }, { id: 'b', from: '2026-10-13', to: '2026-12-01' }], from, to)).toEqual([
      { kind: 'trim_end', id: 'a', from: '2026-01-01', to: '2026-10-12', newTo: from },
      { kind: 'trim_start', id: 'b', from: '2026-10-13', to: '2026-12-01', newFrom: to },
    ]);
  });

  it('splits an open-ended row covering the range on both sides; the tail keeps the open end', () => {
    expect(planRangeSplit([{ id: 'a', from: '2026-01-01', to: null }], from, to)).toEqual([
      { kind: 'split', id: 'a', from: '2026-01-01', to: null, newTo: from, restFrom: to, restTo: null },
    ]);
  });

  it('an open-ended row starting on the first day starts after the range', () => {
    expect(planRangeSplit([{ id: 'a', from, to: null }], from, to)).toEqual([{ kind: 'trim_start', id: 'a', from, to: null, newFrom: to }]);
  });

  it('refuses an empty range', () => {
    expect(() => planRangeSplit([], from, from)).toThrow();
  });
});

describe('runsOf', () => {
  const next = (d: string) => addDays(d, 1);
  it('groups consecutive kept dates and skips the others', () => {
    const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'];
    const rest = new Set(['2026-10-03', '2026-10-04']);
    expect(runsOf(dates, (d) => !rest.has(d), next)).toEqual([{ from: '2026-10-01', to: '2026-10-02' }, { from: '2026-10-05', to: '2026-10-06' }]);
  });
  it('one run when nothing is skipped, none when everything is', () => {
    const dates = ['2026-10-30', '2026-10-31', '2026-11-01'];
    expect(runsOf(dates, () => true, next)).toEqual([{ from: '2026-10-30', to: '2026-11-01' }]);
    expect(runsOf(dates, () => false, next)).toEqual([]);
  });
});
