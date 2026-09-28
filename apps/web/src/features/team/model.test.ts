import { describe, expect, it } from 'vitest';
import type { AttendanceDailyRecordDto } from '@flowza/contracts';
import { approvalRequest } from '@/features/approvals/test-fixtures';
import { canActOnNote, canActOnRequest, filterMembers, leaveOn, leaveRows, monthBounds, monthlyRowsFrom, needsSearch, recentTeamRequests, TEAM_HISTORY_LIMIT } from './model';
import { reviewNote, teamLeave, teamMember } from './test-fixtures';

const rec = (over: Partial<AttendanceDailyRecordDto>): AttendanceDailyRecordDto => ({
  id: 'r', employeeId: 'e5', attendanceDate: '2026-09-01', branchId: 'b1', departmentId: null, shiftId: null, timezone: 'Asia/Muscat', expectedStartAt: null, expectedEndAt: null, scheduledMinutes: 480, firstInAt: null, lastOutAt: null,
  workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null, status: 'PRESENT', flags: [], punchCount: 0, hasCorrection: false, calculationVersion: 1, computedAt: '2026-09-01T00:00:00Z', lockedAt: null, lopDays: 0, ...over,
} as AttendanceDailyRecordDto);

describe('team model', () => {
  it('searches only a team larger than five (Finance B-61), by name without accents or by number', () => {
    expect(needsSearch(5)).toBe(false);
    expect(needsSearch(6)).toBe(true);
    const members = [teamMember({ employeeName: 'Zaïd Al Amri', employeeNumber: 'E001' }), teamMember({ employeeName: 'Salma', employeeNumber: 'E002' })];
    expect(filterMembers(members, 'zaid').map((m) => m.employeeName)).toEqual(['Zaïd Al Amri']);
    expect(filterMembers(members, ' e002 ').map((m) => m.employeeName)).toEqual(['Salma']);
    expect(filterMembers(members, '')).toHaveLength(2);
  });

  it('bounds a month, leap years included', () => {
    expect(monthBounds('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('builds the month grid rows with the register\'s totals (half day = ½ present, late and missing from the flags)', () => {
    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
    const [row] = monthlyRowsFrom([{ employeeId: 'e5', employeeNumber: 'E005', employeeName: 'Salma', branchId: 'b1', departmentId: null, relation: 'primary', records: [
      rec({ id: 'a', attendanceDate: '2026-09-01', status: 'PRESENT', flags: ['LATE'], workedMinutes: 470, lateMinutes: 10 }),
      rec({ id: 'b', attendanceDate: '2026-09-02', status: 'HALF_DAY', workedMinutes: 240 }),
      rec({ id: 'c', attendanceDate: '2026-09-03', status: 'MISSING_PUNCH', flags: ['MISSING_OUT'] }),
      rec({ id: 'd', attendanceDate: '2026-10-01', status: 'ABSENT' }), // outside the grid: ignored
    ] }], days);
    expect(row!.days['2026-09-01']).toMatchObject({ status: 'PRESENT', recordId: 'a', lateMinutes: 10 });
    expect(row!.days['2026-09-04']).toBeNull();
    expect(row!.totals).toMatchObject({ present: 1.5, halfDay: 1, late: 1, missingPunch: 1, absent: 0, workedMinutes: 710, lateMinutes: 10 });
  });

  it('groups the team\'s leave by report and finds the leave covering a day', () => {
    const entries = [teamLeave({ id: 'a', employeeId: 'e6', employeeName: 'Yousuf' }), teamLeave({ id: 'b', employeeId: 'e5', employeeName: 'Amal', startDate: '2026-09-10', endDate: '2026-09-10' }), teamLeave({ id: 'c', employeeId: 'e6', employeeName: 'Yousuf', startDate: '2026-09-20', endDate: '2026-09-21' })];
    const rows = leaveRows(entries);
    expect(rows.map((r) => [r.employeeName, r.entries.length])).toEqual([['Amal', 1], ['Yousuf', 2]]);
    expect(leaveOn(entries, '2026-09-29').map((e) => e.id)).toEqual(['a']);
    expect(leaveOn(entries, '2026-09-15')).toEqual([]);
  });

  it('offers decisions only on what waits for the caller (Finance B-65)', () => {
    expect(canActOnNote(reviewNote())).toBe(true);
    expect(canActOnNote(reviewNote({ isOversight: true }))).toBe(false);
    expect(canActOnNote(reviewNote({ canReview: false }))).toBe(false);
    expect(canActOnNote(reviewNote({ status: 'info_requested' }))).toBe(false);
    expect(canActOnNote(reviewNote({ status: 'approved', canReview: false }))).toBe(false);
    expect(canActOnRequest(approvalRequest())).toBe(true);
    expect(canActOnRequest(approvalRequest({ status: 'APPROVED' }))).toBe(false);
    expect(canActOnRequest(approvalRequest({ abilities: { ...approvalRequest().abilities, canDecide: false } }))).toBe(false);
  });

  it('merges pending and decided team requests newest first, without duplicates, capped at 50 (Finance B-64)', () => {
    const at = (i: number) => new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString();
    const pending = Array.from({ length: 40 }, (_, i) => approvalRequest({ id: `p${i}`, createdAt: at(i) }));
    const history = [...Array.from({ length: 30 }, (_, i) => approvalRequest({ id: `h${i}`, createdAt: at(100 + i) })), approvalRequest({ id: 'p0', createdAt: at(0) })];
    const merged = recentTeamRequests([pending, history]);
    expect(merged).toHaveLength(TEAM_HISTORY_LIMIT);
    expect(merged[0]!.id).toBe('h29');
    expect(new Set(merged.map((r) => r.id)).size).toBe(merged.length);
    expect(merged.at(-1)!.id).toBe('p20');
  });
});
