import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import type { AttendanceCalendarDayDto, AttendanceCalendarRowDto } from '@flowza/contracts';
import { CalendarView } from './calendar-view';

const EMP = '11111111-1111-4111-8111-111111111111';
const day = (recordId: string, over: Partial<AttendanceCalendarDayDto> = {}): AttendanceCalendarDayDto => ({
  recordId, status: 'PRESENT', flags: [], statusSource: 'AUTO', firstInAt: '2026-09-01T04:05:00Z', lastOutAt: '2026-09-01T13:10:00Z',
  workedMinutes: 545, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, timezone: 'Asia/Muscat', ...over,
});
const row: AttendanceCalendarRowDto = {
  employeeId: EMP, employeeNumber: '1001', employeeName: 'Ali Hassan', branchId: 'b1', departmentId: null, joiningDate: '2025-01-01', exitDate: null,
  days: {
    '2026-09-01': day('rec-1', { flags: ['LATE', 'OVERTIME'], lateMinutes: 12, overtimeMinutes: 30 }),
    '2026-09-02': day('rec-2', { status: 'ABSENT', firstInAt: null, lastOutAt: null, workedMinutes: 0, statusSource: 'MANUAL', flags: ['MANUAL_CORRECTION', 'UNEXCUSED'] }),
    '2026-09-03': day('rec-3', { status: 'LEAVE', firstInAt: null, lastOutAt: null, workedMinutes: 0 }),
    '2026-09-15': day('rec-15', { flags: ['MISSING_OUT'], lastOutAt: null }),
  },
};
const calendar = { data: [row], meta: { page: 1, pageSize: 12, total: 1, totalPages: 1, month: '2026-09', days: [], today: '2026-09-15' } };
const record = {
  id: 'rec-1', employeeId: EMP, employeeName: 'Ali Hassan', employeeNumber: '1001', branchId: 'b1', attendanceDate: '2026-09-01', timezone: 'Asia/Muscat', status: 'PRESENT', flags: ['LATE'],
  shiftId: 's1', shiftName: 'Day shift', expectedStartAt: '2026-09-01T04:00:00Z', expectedEndAt: '2026-09-01T13:00:00Z', firstInAt: '2026-09-01T04:12:00Z', lastOutAt: '2026-09-01T13:30:00Z',
  workedMinutes: 558, breakMinutes: 0, scheduledMinutes: 540, lateMinutes: 12, earlyDepartureMinutes: 0, overtimeMinutes: 30, overtimeCategory: 'REGULAR', punchCount: 2,
  calculationVersion: 2, computedAt: '2026-09-01T14:00:00Z', lockedAt: null, lopDays: 0, ruleSetId: null, shiftAssignmentId: null, engineVersion: '1', trace: null,
  events: [], history: [], marks: [], corrections: [{ id: 'c1', type: 'SET_STATUS', status: 'APPLIED', proposedStatus: 'PRESENT', employeeId: EMP, branchId: 'b1', attendanceDate: '2026-09-01', originalEventId: null, originalPunchedAt: null, proposedPunchedAt: null, proposedEventType: null, reason: 'x', requestedBy: null, approvalRequestId: null, appliedEventId: null, appliedAt: null, rejectionReason: null, createdAt: '2026-09-01T15:00:00Z', updatedAt: '2026-09-01T15:00:00Z' }],
};

describe('CalendarView', () => {
  beforeEach(() => {
    resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat';
    mockGet({ '/orgs/org-1/attendance/calendar': calendar, '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/employees': page([]), '/orgs/org-1/attendance/records/rec-1': { data: record } });
  });

  it('draws one month per employee with status colours, flag dots, the manual marker, today and a legend with the Finance mapping', async () => {
    renderWithProviders(<CalendarView />, { route: '/attendance?tab=calendar&month=2026-09' });
    const card = await screen.findByTestId('calendar-employee');
    expect(card).toHaveTextContent('Ali Hassan');
    const cell = (d: string) => card.querySelector(`[data-day="${d}"]`) as HTMLElement;
    expect(cell('2026-09-01').dataset['status']).toBe('PRESENT');
    expect(cell('2026-09-01').className).toMatch(/bg-emerald-500/);
    expect(cell('2026-09-01').querySelectorAll('.bg-amber-500, .bg-blue-600')).toHaveLength(2); // late + overtime dots
    expect(cell('2026-09-02').className).toMatch(/bg-red-500/);
    expect(within(cell('2026-09-02')).getByTestId('manual-marker')).toBeInTheDocument();
    expect(cell('2026-09-03').dataset['status']).toBe('LEAVE');
    expect(cell('2026-09-15').dataset['today']).toBe('true');
    expect(cell('2026-09-15').className).toMatch(/ring-primary/);
    expect(cell('2026-09-04').dataset['status']).toBe('none');
    // tooltip: in / out / worked / late / overtime
    const title = cell('2026-09-01').closest('button')!.getAttribute('title')!;
    expect(title).toContain('Present');
    expect(title).toContain('08:05–17:10');
    expect(title).toContain('Late 12m');
    expect(title).toContain('OT 30m');
    expect(cell('2026-09-02').closest('button')!.getAttribute('title')).toContain('Absent (Manual)');
    const legend = screen.getByTestId('calendar-legend');
    expect(legend).toHaveTextContent('Manual status');
    expect(legend).toHaveTextContent('Today');
    expect(within(screen.getByTestId('finance-mapping')).getAllByRole('row')).toHaveLength(11); // header + ten statuses
  });

  it('opens the record of a day with a punch timeline and Edit record, and Add record on an empty day', async () => {
    apiMock.post.mockResolvedValue({ data: { employeeId: EMP, employeeNumber: '1001', employeeName: 'Ali Hassan', date: '2026-09-04', timezone: 'Asia/Muscat', recordId: null, shift: null, current: { status: 'ABSENT', flags: [], firstInAt: null, lastOutAt: null, workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, scheduledMinutes: 0, punchCount: 0, lopDays: 0 }, preview: { status: 'ABSENT', flags: [], firstInAt: null, lastOutAt: null, workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, scheduledMinutes: 0, punchCount: 0, lopDays: 0 }, statusSource: 'AUTO', manualStatus: null, punches: { in: null, out: null }, plan: [], pendingCorrections: 0, locked: false } });
    renderWithProviders(<CalendarView />, { route: '/attendance?tab=calendar&month=2026-09' });
    const card = await screen.findByTestId('calendar-employee');
    fireEvent.click(card.querySelector('[data-day="2026-09-01"]')!.closest('button')!);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Day shift');
    expect(within(dialog).getByTestId('status-source-MANUAL')).toBeInTheDocument(); // an applied SET_STATUS correction
    expect(within(dialog).getByRole('button', { name: /Punch timeline/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Edit record/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(card.querySelector('[data-day="2026-09-04"]')!.closest('button')!);
    expect(await screen.findByRole('heading', { name: 'Add record' })).toBeInTheDocument();
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/preview', { employeeId: EMP, date: '2026-09-04' }));
  });

  it('offers no Add / Edit record without the HR edit permissions', async () => {
    grant('attendance.view');
    renderWithProviders(<CalendarView />, { route: '/attendance?tab=calendar&month=2026-09' });
    const card = await screen.findByTestId('calendar-employee');
    expect(card.querySelector('[data-day="2026-09-04"]')!.closest('button')).toBeNull();
    fireEvent.click(card.querySelector('[data-day="2026-09-01"]')!.closest('button')!);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Day shift');
    expect(within(dialog).queryByRole('button', { name: /Edit record/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Punch timeline/ })).toBeInTheDocument();
  });
});
