import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { AttendanceActivityDayDto, AttendanceActivityDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);

import { grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { ActivityTab } from './activity-tab';
import { buildTimeline, datesOf, minuteOfDay, targetMinutes, tickLabel } from './activity-model';

const EMP = 'e1';
const TZ = 'Asia/Muscat'; // UTC+4, no DST

const day = (over: Partial<AttendanceActivityDayDto> = {}): AttendanceActivityDayDto => ({
  date: '2026-09-01', recordId: 'r1', status: 'PRESENT', shiftName: 'General', expectedStartAt: null, expectedEndAt: null, scheduledMinutes: 480,
  firstInAt: '2026-09-01T04:00:00.000Z', lastOutAt: '2026-09-01T13:00:00.000Z', spanMinutes: 540, officeMinutes: 360, fieldMinutes: 180, breakMinutes: 180,
  overtimeMinutes: 0, overtimeCategory: null, lateMinutes: 0, earlyDepartureMinutes: 0, punchCount: 4, flags: [],
  segments: [
    { kind: 'OFFICE', startAt: '2026-09-01T04:00:00.000Z', endAt: '2026-09-01T06:00:00.000Z', minutes: 120 },
    { kind: 'FIELD', startAt: '2026-09-01T06:00:00.000Z', endAt: '2026-09-01T09:00:00.000Z', minutes: 180 },
    { kind: 'OFFICE', startAt: '2026-09-01T09:00:00.000Z', endAt: '2026-09-01T13:00:00.000Z', minutes: 240 },
  ],
  punches: [],
  ...over,
});

const activity = (over: Partial<AttendanceActivityDto> = {}): AttendanceActivityDto => ({
  employeeId: EMP, employeeNumber: 'MG-001', employeeName: 'K Prem Kumar', range: 'week', from: '2026-08-30', to: '2026-09-05', timezone: TZ,
  days: [day()], months: [],
  totals: {
    recordedDays: 1, workingDays: 1, presentDays: 1, absentDays: 0, leaveDays: 0, holidayDays: 0, weeklyOffDays: 0, halfDays: 0, lateDays: 0, missingPunchDays: 0,
    scheduledMinutes: 480, spanMinutes: 540, officeMinutes: 360, fieldMinutes: 180, overtimeMinutes: 0, regularMinutes: 360, lateMinutes: 0, earlyDepartureMinutes: 0, averageOfficeMinutes: 360,
  },
  ...over,
});

describe('activity model', () => {
  it('measures a punch against local midnight, including a shift that crosses it', () => {
    expect(minuteOfDay('2026-09-01T04:00:00.000Z', '2026-09-01', TZ)).toBe(8 * 60); // 08:00 local
    expect(minuteOfDay('2026-09-01T20:30:00.000Z', '2026-09-01', TZ)).toBe(24 * 60 + 30); // 00:30 the next day
  });

  it('lays every day out on one window, keeps days without a record and pads the edges', () => {
    const timeline = buildTimeline(['2026-09-01', '2026-09-02'], [day()], TZ);
    expect(timeline.fromMinute).toBe(7 * 60 + 30); // 08:00 first punch, floored to the hour, minus 30 min of air
    expect(timeline.toMinute).toBe(17 * 60 + 30); // 17:00 last punch + 30
    expect(timeline.rows.map((r) => r.status)).toEqual(['PRESENT', 'NO_RECORD']);
    expect(timeline.rows[1]!.bars).toEqual([]);
    const bars = timeline.rows[0]!.bars;
    expect(bars.map((b) => b.kind)).toEqual(['OFFICE', 'FIELD', 'OFFICE']);
    expect(bars[0]!.startPct).toBeCloseTo(5, 5); // 08:00 is 30 min into a 600-minute window
    expect(bars[0]!.widthPct).toBeCloseTo(20, 5); // two hours of it
    expect(bars.every((b) => !b.open)).toBe(true);
  });

  it('draws an unclosed span to the end of the window and marks it open', () => {
    const open = day({ lastOutAt: null, segments: [{ kind: 'OFFICE', startAt: '2026-09-01T04:00:00.000Z', endAt: null, minutes: 0 }] });
    const bar = buildTimeline(['2026-09-01'], [open], TZ).rows[0]!.bars[0]!;
    expect(bar.open).toBe(true);
    expect(bar.startPct + bar.widthPct).toBeCloseTo(100, 5);
  });

  it('falls back to a default window with no punches at all, and labels ticks past midnight', () => {
    const timeline = buildTimeline(['2026-09-01'], [], TZ);
    expect([timeline.fromMinute, timeline.toMinute]).toEqual([6 * 60 + 30, 19 * 60 + 30]);
    expect(tickLabel(1500)).toBe('01:00');
  });

  it('builds the date axis and picks the shift length most days share as the target', () => {
    expect(datesOf('2026-08-30', '2026-09-02')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
    expect(datesOf('2026-09-02', '2026-09-01')).toEqual([]);
    expect(targetMinutes([day(), day({ date: '2026-09-02' }), day({ date: '2026-09-03', scheduledMinutes: 300 })])).toBe(480);
    expect(targetMinutes([day({ scheduledMinutes: 0 })])).toBeNull();
  });
});

describe('ActivityTab', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.timezone = TZ; });

  it('shows the productive and field totals, the heartbeat and the day details', async () => {
    mockGet({
      '/orgs/org-1/attendance/activity': (query: Record<string, unknown> | undefined) => {
        expect(query).toMatchObject({ employeeId: EMP, range: 'week' });
        return { data: activity() };
      },
    });
    renderWithProviders(<ActivityTab employeeId={EMP} />);

    expect(await screen.findByText('30 Aug – 05 Sep 2026')).toBeInTheDocument();
    expect(screen.getByText('Productive hours').closest('div')?.parentElement).toHaveTextContent('6h 00m');
    expect(screen.getByText('Field / away', { selector: 'p' }).closest('div')?.parentElement).toHaveTextContent('3h 00m');
    expect(screen.getByText('33% of the time between first and last punch')).toBeInTheDocument();
    // the heartbeat renders one row per calendar day of the period, not only the recorded one
    const heartbeat = within(screen.getByText('Day heartbeat').closest('section')!);
    expect(heartbeat.getAllByRole('listitem')).toHaveLength(7);
    expect(heartbeat.getAllByText('No record')).toHaveLength(6);
    const total = screen.getByText('Total').closest('tr')!;
    expect(within(total).getByText('6h 00m')).toBeInTheDocument();
    expect(within(total).getByText('3h 00m')).toBeInTheDocument();
  });

  it('asks the server for the year and renders the month rollup instead of the timeline', async () => {
    const seen: string[] = [];
    mockGet({
      '/orgs/org-1/attendance/activity': (query: Record<string, unknown> | undefined) => {
        seen.push(String(query?.range));
        if (query?.range !== 'year') return { data: activity() };
        return { data: activity({
          range: 'year', from: '2026-01-01', to: '2026-12-31', days: [],
          months: [{ month: '2026-09', recordedDays: 20, presentDays: 20, absentDays: 0, leaveDays: 0, lateDays: 2, scheduledMinutes: 9600, officeMinutes: 9000, fieldMinutes: 1200, overtimeMinutes: 300 }],
        }) };
      },
    });
    renderWithProviders(<ActivityTab employeeId={EMP} />);
    await screen.findByText('30 Aug – 05 Sep 2026');

    fireEvent.keyDown(screen.getByLabelText('Period'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Year' }));

    expect(await screen.findByText('2026')).toBeInTheDocument();
    expect(seen).toContain('year');
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(screen.queryByText('Day heartbeat')).not.toBeInTheDocument();
  });

  it('shows the day\'s punch log when the period is a single day', async () => {
    mockGet({
      '/orgs/org-1/attendance/activity': (query: Record<string, unknown> | undefined) => ({
        data: query?.range === 'day'
          ? activity({ range: 'day', from: '2026-09-01', to: '2026-09-01', days: [day({ punches: [
            { at: '2026-09-01T04:00:00.000Z', role: 'IN', eventId: null },
            { at: '2026-09-01T06:00:00.000Z', role: 'OUT', eventId: null },
            { at: '2026-09-01T09:00:00.000Z', role: 'IN', eventId: null },
            { at: '2026-09-01T13:00:00.000Z', role: 'OUT', eventId: null },
          ] })] })
          : activity(),
      }),
    });
    renderWithProviders(<ActivityTab employeeId={EMP} />);
    await screen.findByText('30 Aug – 05 Sep 2026');

    fireEvent.keyDown(screen.getByLabelText('Period'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Day' }));

    const punches = within((await screen.findByText('Punches')).closest('section')!);
    expect(punches.getAllByRole('listitem')).toHaveLength(4);
    expect(punches.getByText('08:00')).toBeInTheDocument(); // 04:00 UTC in Asia/Muscat
    expect(punches.getAllByText('in')).toHaveLength(2);
  });

  it('offers the empty state when the period has no records', async () => {
    mockGet({ '/orgs/org-1/attendance/activity': { data: activity({ days: [], totals: { ...activity().totals, recordedDays: 0, workingDays: 0, presentDays: 0, officeMinutes: 0, fieldMinutes: 0, spanMinutes: 0, scheduledMinutes: 0, averageOfficeMinutes: 0 } }) } });
    renderWithProviders(<ActivityTab employeeId={EMP} />);
    expect(await screen.findByText('No attendance recorded in this period')).toBeInTheDocument();
    expect(screen.queryByText('Details')).not.toBeInTheDocument();
  });
});
