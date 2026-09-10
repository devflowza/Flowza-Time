import { describe, expect, it } from 'vitest';
import { activitySegments, segmentMinutes, type ActivityPunchLike } from './activity.js';

const p = (punchedAt: string, role: string): ActivityPunchLike => ({ punchedAt, role });

describe('activitySegments', () => {
  it('pairs IN/OUT into in-office spans and the gaps between them into field spans', () => {
    const segments = activitySegments([
      p('2026-09-01T04:00:00.000Z', 'IN'),
      p('2026-09-01T06:00:00.000Z', 'OUT'),
      p('2026-09-01T09:30:00.000Z', 'IN'),
      p('2026-09-01T13:00:00.000Z', 'OUT'),
    ]);
    expect(segments).toEqual([
      { kind: 'OFFICE', startAt: '2026-09-01T04:00:00.000Z', endAt: '2026-09-01T06:00:00.000Z', minutes: 120 },
      { kind: 'FIELD', startAt: '2026-09-01T06:00:00.000Z', endAt: '2026-09-01T09:30:00.000Z', minutes: 210 },
      { kind: 'OFFICE', startAt: '2026-09-01T09:30:00.000Z', endAt: '2026-09-01T13:00:00.000Z', minutes: 210 },
    ]);
    expect(segmentMinutes(segments)).toEqual({ officeMinutes: 330, fieldMinutes: 210 });
  });

  it('treats BREAK_START/BREAK_END as leaving and coming back, and ignores the roles that are not state changes', () => {
    const segments = activitySegments([
      p('2026-09-01T04:00:00.000Z', 'IN'),
      p('2026-09-01T08:00:00.000Z', 'BREAK_START'),
      p('2026-09-01T08:45:00.000Z', 'DUPLICATE'),
      p('2026-09-01T09:00:00.000Z', 'BREAK_END'),
      p('2026-09-01T10:00:00.000Z', 'IGNORED'),
      p('2026-09-01T13:00:00.000Z', 'OUT'),
    ]);
    expect(segments.map((s) => `${s.kind}:${s.minutes}`)).toEqual(['OFFICE:240', 'FIELD:60', 'OFFICE:240']);
  });

  it('sorts punches, skips a second IN and an OUT that opens nothing, and never emits a trailing field span', () => {
    const segments = activitySegments([
      p('2026-09-01T06:00:00.000Z', 'OUT'),
      p('2026-09-01T04:00:00.000Z', 'IN'),
      p('2026-09-01T05:00:00.000Z', 'IN'),
      p('2026-09-01T03:00:00.000Z', 'OUT'),
    ]);
    expect(segments).toEqual([
      { kind: 'OFFICE', startAt: '2026-09-01T04:00:00.000Z', endAt: '2026-09-01T06:00:00.000Z', minutes: 120 },
    ]);
  });

  it('leaves an unclosed span open instead of guessing when the employee has not punched out', () => {
    const segments = activitySegments([p('2026-09-01T04:00:00.000Z', 'IN'), p('2026-09-01T06:00:00.000Z', 'OUT'), p('2026-09-01T07:00:00.000Z', 'IN')]);
    expect(segments.at(-1)).toEqual({ kind: 'OFFICE', startAt: '2026-09-01T07:00:00.000Z', endAt: null, minutes: 0 });
    expect(segmentMinutes(segments)).toEqual({ officeMinutes: 120, fieldMinutes: 60 });
  });

  it('falls back to first-in → last-out for a record whose trace carries no usable punch', () => {
    const bounds = { firstInAt: '2026-09-01T04:00:00.000Z', lastOutAt: '2026-09-01T13:00:00.000Z' };
    const expected = [{ kind: 'OFFICE', startAt: bounds.firstInAt, endAt: bounds.lastOutAt, minutes: 540 }];
    expect(activitySegments(null, bounds)).toEqual(expected);
    expect(activitySegments([], bounds)).toEqual(expected);
    expect(activitySegments([p('2026-09-01T04:00:00.000Z', 'OUT_OF_WINDOW'), { role: 'IN' }, { punchedAt: 'not-a-date', role: 'IN' }], bounds)).toEqual(expected);
  });

  it('invents nothing for a record with neither punches nor punch times', () => {
    expect(activitySegments(undefined)).toEqual([]);
    expect(activitySegments([], { firstInAt: null, lastOutAt: null })).toEqual([]);
    expect(activitySegments([], { firstInAt: '2026-09-01T04:00:00.000Z' })).toEqual([{ kind: 'OFFICE', startAt: '2026-09-01T04:00:00.000Z', endAt: null, minutes: 0 }]);
    expect(activitySegments([], { firstInAt: '2026-09-01T04:00:00.000Z', lastOutAt: '2026-09-01T03:00:00.000Z' })).toEqual([{ kind: 'OFFICE', startAt: '2026-09-01T04:00:00.000Z', endAt: null, minutes: 0 }]);
  });
});
