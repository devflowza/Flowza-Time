import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { toast } from '@/lib/toast';
import { DailyView } from './daily-view';
import { shortfallLabel } from '../shortfall';

/**
 * The daily register (2026-10-19): the "Short" column (the reports' UT from the API) and the export of the CURRENT view — date
 * and every filter — as a queued Daily Report whose toast opens Reports (never /sync/<queue job id>).
 */
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const DEPT = '33333333-3333-4333-8333-333333333333';
const rec = (id: string, employeeId: string, name: string, extra: Record<string, unknown>) => ({
  id, employeeId, employeeName: name, employeeNumber: id.toUpperCase(), branchId: 'b1', branchName: 'Muscat', attendanceDate: '2026-10-18', timezone: 'Asia/Muscat', status: 'PRESENT', flags: [],
  shiftId: null, shiftName: 'Day shift', expectedStartAt: null, expectedEndAt: null, firstInAt: '2026-10-18T04:45:00Z', lastOutAt: '2026-10-18T12:00:00Z', workedMinutes: 405, breakMinutes: 0, scheduledMinutes: 480,
  lateMinutes: 45, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null, punchCount: 2, hasCorrection: false, calculationVersion: 1, computedAt: '2026-10-18T18:00:00Z', lockedAt: null, lopDays: 0, unexcused: false,
  shortfallMinutes: 0, ...extra,
});
const daily = { data: [rec('r1', E1, 'Ali Hassan', { flags: ['LATE'], shortfallMinutes: 75 }), rec('r2', E2, 'Sara Nasser', { lateMinutes: 0, workedMinutes: 480 })], meta: { page: 1, pageSize: 25, total: 2, totalPages: 1, byStatus: { PRESENT: 2 }, missingPunch: 0 } };

describe('DailyView — shortfall and the export of the current view', () => {
  beforeEach(() => {
    resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat';
    mockGet({
      '/orgs/org-1/attendance/daily': daily, '/orgs/org-1/attendance/manual-statuses': { data: [] },
      '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/shifts': page([]), '/orgs/org-1/employees': page([]),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows how short each day was in a Short column (the exact minutes on hover), a dash when it was not', async () => {
    renderWithProviders(<DailyView />, { route: '/attendance?tab=daily&date=2026-10-18' });
    const table = (await screen.findAllByRole('table'))[0]!;
    expect(within(table).getByRole('columnheader', { name: 'Short' })).toBeInTheDocument();
    const rows = await within(table).findAllByRole('row');
    const ali = rows.find((r) => r.textContent?.includes('Ali Hassan'))!;
    const sara = rows.find((r) => r.textContent?.includes('Sara Nasser'))!;
    const short = within(ali).getByTestId('shortfall');
    expect(short).toHaveTextContent('1h 15m');
    expect(short).toHaveAttribute('title', "75 min short of the shift's hours");
    expect(within(sara).queryByTestId('shortfall')).not.toBeInTheDocument();
  });

  it('exports the register as filtered now (date, department, status, flag, search) and points the toast at Reports', async () => {
    apiMock.post.mockResolvedValue({ data: { reportId: 'rep-1', jobId: '981', status: 'QUEUED', reportType: 'daily_attendance', rowCount: 1 } });
    const success = vi.spyOn(toast, 'success');
    renderWithProviders(<DailyView />, { route: `/attendance?tab=daily&date=2026-10-18&departmentId=${DEPT}&status=PRESENT&flag=LATE&search=ali` });
    await screen.findAllByRole('table');
    fireEvent.keyDown(screen.getByTestId('register-export'), { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('register-export-xlsx'));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body, opts] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/attendance/daily/export');
    expect(body).toEqual({ date: '2026-10-18', format: 'xlsx', departmentId: DEPT, status: 'PRESENT', flag: 'LATE', search: 'ali' });
    expect(opts).toMatchObject({ idempotencyKey: expect.any(String) });
    await waitFor(() => expect(success).toHaveBeenCalledWith('Queued successfully', expect.objectContaining({ description: expect.stringMatching(/Exporting 1 records/), action: expect.objectContaining({ label: 'Open Reports' }) })));
  });

  it('offers no export without report.export, or without the organisation-wide attendance read', async () => {
    grant('attendance.view', 'report.view');
    const { unmount } = renderWithProviders(<DailyView />, { route: '/attendance?tab=daily&date=2026-10-18' });
    await screen.findAllByRole('table');
    expect(screen.queryByTestId('register-export')).not.toBeInTheDocument();
    unmount();
    grant('attendance.view_team', 'report.view', 'report.export');
    renderWithProviders(<DailyView />, { route: '/attendance?tab=daily&date=2026-10-18' });
    await screen.findAllByRole('table');
    expect(screen.queryByTestId('register-export')).not.toBeInTheDocument();
  });

  it('spells a shortfall out as hours and minutes with the exact minutes', () => {
    const t = (key: string, o?: Record<string, unknown>) => (key === 'record.shortfallValue' ? `${String(o?.['hours'])} h ${String(o?.['minutes'])} min (${String(o?.['total'])} min)` : `${String(o?.['total'])} min`);
    expect(shortfallLabel(t, 75)).toBe('1 h 15 min (75 min)');
    expect(shortfallLabel(t, 45)).toBe('45 min');
    expect(shortfallLabel(t, 0)).toBeNull();
    expect(shortfallLabel(t, undefined)).toBeNull();
  });
});
