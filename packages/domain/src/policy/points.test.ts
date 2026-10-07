import { describe, expect, it } from 'vitest';
import { attendancePolicySectionsSchema } from '@flowza/contracts';
import { computeAttendancePoints, type PointsDayRecord } from './points.js';

const sections = (over: Record<string, unknown> = {}) => attendancePolicySectionsSchema.parse({
  late: { repeatedLate: { occurrences: 3, periodDays: 7 } },
  points: {
    enabled: true, expiryDays: 30,
    escalation: [{ points: 5, action: 'NOTIFY_MANAGER' }, { points: 10, action: 'VERBAL_WARNING' }, { points: 20, action: 'WRITTEN_WARNING' }, { points: 30, action: 'FINAL_WARNING' }],
  },
  ...over,
});
const day = (date: string, flags: string[] = [], status = 'PRESENT'): PointsDayRecord => ({ date, status, flags });

const MARCH: PointsDayRecord[] = [
  day('2026-03-01', ['LATE']), // the day before the window
  day('2026-03-02', ['LATE']),
  day('2026-03-03', ['LATE', 'VERY_LATE']),
  day('2026-03-04', ['LATE', 'EXCUSED']), // excused: nothing, and no repeated-late count
  day('2026-03-05', ['LATE']), // third late day within 7 days → REPEATED_LATE, count restarts
  day('2026-03-06', ['UNEXCUSED'], 'ABSENT'),
  day('2026-03-09', ['MISSING_OUT', 'EARLY_DEPARTURE'], 'MISSING_PUNCH'), // one MISSING_PUNCH for the status and the flag
  day('2026-03-10', ['MISSING_IN', 'MISSING_OUT', 'EXCUSED'], 'PRESENT'),
  day('2026-03-12', ['LATE']),
  day('2026-03-20', ['LATE']), // the 12th is out of the last 7 days
  day('2026-03-21', ['LATE']),
  day('2026-03-22', ['VERY_LATE']), // 20, 21, 22 → REPEATED_LATE
];

describe('computeAttendancePoints', () => {
  it('scores each day once per kind, inside the rolling window, and finds the escalation step', () => {
    const r = computeAttendancePoints(MARCH, sections(), '2026-03-31');
    expect(r.windowFrom).toBe('2026-03-02');
    expect(r.events.map((e) => `${e.date}:${e.kind}:${e.points}`)).toEqual([
      '2026-03-02:LATE:1', '2026-03-03:VERY_LATE:2', '2026-03-05:LATE:1', '2026-03-05:REPEATED_LATE:2', '2026-03-06:ABSENT:3', '2026-03-06:UNEXCUSED:2',
      '2026-03-09:EARLY_DEPARTURE:1', '2026-03-09:MISSING_PUNCH:1', '2026-03-12:LATE:1', '2026-03-20:LATE:1', '2026-03-21:LATE:1', '2026-03-22:VERY_LATE:2', '2026-03-22:REPEATED_LATE:2',
    ]);
    expect(r.total).toBe(20);
    expect(r.occurrences).toEqual({ LATE: 5, VERY_LATE: 2, EARLY_DEPARTURE: 1, ABSENT: 1, MISSING_PUNCH: 1, UNEXCUSED: 1, REPEATED_LATE: 2 });
    expect(r.escalation).toEqual({ action: 'WRITTEN_WARNING', threshold: 20 });
    expect(r.nextEscalation).toEqual({ action: 'FINAL_WARNING', threshold: 30 });
    expect(r.events[0]!.expiresOn).toBe('2026-04-01'); // date + expiryDays: the first day it no longer counts
  });

  it('points drop off after expiryDays; the repeated-late walk only reads the window', () => {
    // window 2026-03-07 … 2026-04-05: the first week's events have expired, and 20/21/22 still make one repeated late
    const r = computeAttendancePoints(MARCH, sections(), '2026-04-05');
    expect(r.windowFrom).toBe('2026-03-07');
    expect(r.events.map((e) => e.date)).toEqual(['2026-03-09', '2026-03-09', '2026-03-12', '2026-03-20', '2026-03-21', '2026-03-22', '2026-03-22']);
    expect(r.total).toBe(9);
    expect(r.escalation).toEqual({ action: 'NOTIFY_MANAGER', threshold: 5 });
    expect(r.nextEscalation).toEqual({ action: 'VERBAL_WARNING', threshold: 10 });
  });

  it('excused days earn nothing and do not count towards repeated late', () => {
    const r = computeAttendancePoints([day('2026-05-04', ['LATE']), day('2026-05-05', ['LATE', 'EXCUSED']), day('2026-05-06', ['UNEXCUSED', 'EXCUSED'], 'ABSENT'), day('2026-05-07', ['LATE'])], sections(), '2026-05-31');
    expect(r.events.map((e) => e.kind)).toEqual(['LATE', 'LATE']);
    expect(r.occurrences.REPEATED_LATE).toBe(0);
  });

  it('repeated late restarts after each occurrence and forgets late days older than the period', () => {
    const late = (d: string) => day(d, ['LATE']);
    const r = computeAttendancePoints([late('2026-06-01'), late('2026-06-02'), late('2026-06-03'), late('2026-06-04'), late('2026-06-05'), late('2026-06-13'), late('2026-06-14'), late('2026-06-20')], sections(), '2026-06-30');
    // 1-2-3 → one, then the count restarts; 4, 5 and 13: on the 13th, 4 and 5 are more than 7 days back → none; 13, 14 and
    // 20: on the 20th the 13th is more than 7 days back → none
    expect(r.events.filter((e) => e.kind === 'REPEATED_LATE').map((e) => e.date)).toEqual(['2026-06-03']);
    const wide = computeAttendancePoints([late('2026-06-01'), late('2026-06-02'), late('2026-06-03'), late('2026-06-04'), late('2026-06-05'), late('2026-06-06')], sections({ late: { repeatedLate: { occurrences: 2, periodDays: 7 } } }), '2026-06-30');
    expect(wide.events.filter((e) => e.kind === 'REPEATED_LATE').map((e) => e.date)).toEqual(['2026-06-02', '2026-06-04', '2026-06-06']);
  });

  it('a policy without points, or without repeated late, scores accordingly', () => {
    const off = computeAttendancePoints(MARCH, attendancePolicySectionsSchema.parse({}), '2026-03-31');
    expect(off).toMatchObject({ enabled: false, total: 0, events: [], escalation: null, nextEscalation: null });
    const noRepeat = computeAttendancePoints(MARCH, sections({ late: { repeatedLate: null } }), '2026-03-31');
    expect(noRepeat.occurrences.REPEATED_LATE).toBe(0);
    expect(noRepeat.total).toBe(16);
    expect(noRepeat.escalation).toEqual({ action: 'VERBAL_WARNING', threshold: 10 });
  });

  it('half points add up exactly and an empty ladder escalates to nothing', () => {
    const s = sections({ points: { enabled: true, late: 0.5, expiryDays: 90 } });
    const r = computeAttendancePoints([day('2026-07-01', ['LATE']), day('2026-07-02', ['LATE']), day('2026-07-20', ['LATE'])], s, '2026-07-31');
    expect(r.total).toBe(1.5);
    expect(r.escalation).toBeNull();
    expect(r.nextEscalation).toBeNull();
  });
});
