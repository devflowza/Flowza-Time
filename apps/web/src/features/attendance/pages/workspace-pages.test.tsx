import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import type { AttendanceSummaryRowDto, UnmatchedPunchGroupDto } from '@flowza/contracts';
import AttendanceSummaryPage from './summary-page';
import UnmatchedPunchesPage from './unmatched-page';
import AttendancePrintPage from './print-page';

const E1 = '11111111-1111-4111-8111-111111111111';
const figures = { presentDays: 20.5, lateDays: 3, halfDays: 1, leaveDays: 2, absentDays: 1, missingPunchDays: 1, holidayDays: 1, weeklyOffDays: 8, daysWorked: 21, workedMinutes: 10_080, overtimeMinutes: 150, averageWorkedMinutes: 480, lopDays: 0.5, unexcusedDays: 1, pendingDays: 0, recordCount: 30 };
const summaryRow: AttendanceSummaryRowDto = { ...figures, employeeId: E1, employeeNumber: '1001', employeeName: 'Ali Hassan', branchId: 'b1', branchName: 'Muscat', departmentId: 'd1', departmentName: 'Sales', source: 'LIVE', finalizedAt: null };
const summary = { data: [summaryRow], meta: { page: 1, pageSize: 50, total: 1, totalPages: 1, month: '2026-08', from: '2026-08-01', to: '2026-08-31', totals: figures } };

describe('AttendanceSummaryPage', () => {
  beforeEach(() => {
    resetApiMock(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat';
    mockGet({ '/orgs/org-1/attendance/summary': summary, '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/employees': page([]),
      '/orgs/org-1/attendance/summary/export': (q: Record<string, unknown> | undefined) => { expect(q).toMatchObject({ month: '2026-08' }); return { data: { fileName: 'attendance-summary-2026-08.csv', contentType: 'text/csv', content: '\uFEFFEmployee\r\n', rowCount: 1 } }; } });
  });

  it('shows one row per employee with the month totals, and exports CSV for report.export holders', async () => {
    grantAll();
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderWithProviders(<AttendanceSummaryPage />, { route: '/attendance/summary?month=2026-08' });
    const table = (await screen.findAllByRole('table'))[0]!;
    const row = (await within(table).findAllByRole('row')).find((r) => r.textContent?.includes('Ali Hassan'))!;
    expect(row).toHaveTextContent('20.5');
    expect(row).toHaveTextContent('168:00'); // worked h:mm
    expect(row).toHaveTextContent('2:30'); // overtime
    expect(row).toHaveTextContent('Live');
    expect(screen.getByTestId('summary-totals')).toHaveTextContent('20.5');
    fireEvent.click(screen.getByTestId('summary-export'));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/attendance/summary/export', expect.objectContaining({ month: '2026-08' }));
  });

  it('hides the CSV export without report.export (managers read their team)', async () => {
    grant('attendance.view_team', 'report.view');
    renderWithProviders(<AttendanceSummaryPage />, { route: '/attendance/summary?month=2026-08' });
    await screen.findAllByText('Ali Hassan');
    expect(screen.queryByTestId('summary-export')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument();
  });
});

const group = (over: Partial<UnmatchedPunchGroupDto> = {}): UnmatchedPunchGroupDto => ({
  deviceId: 'dev-1', deviceName: 'Main gate', deviceCode: 'GATE-1', providerKey: 'zkteco', branchId: 'b1', branchName: 'Muscat', deviceEmployeeId: '77', status: 'unmatched', count: 12,
  firstPunchAt: '2026-09-01T04:00:00Z', lastPunchAt: '2026-09-10T13:00:00Z', lastReceivedAt: '2026-09-10T13:01:00Z',
  suggestions: [{ employeeId: E1, employeeNumber: '77', displayName: 'Ali Hassan', reason: 'employee_number' }], ...over,
});

describe('UnmatchedPunchesPage', () => {
  beforeEach(() => {
    resetApiMock(); testState.orgId = 'org-1';
    mockGet({ '/orgs/org-1/attendance/unmatched': (q: Record<string, unknown> | undefined) => page(q?.['status'] === 'ignored' ? [group({ status: 'ignored', deviceEmployeeId: '88', suggestions: [] })] : [group()]), '/orgs/org-1/branches': page([]), '/orgs/org-1/devices': page([]), '/orgs/org-1/employees': page([]) });
  });

  it('groups unmatched punches, assigns the suggested employee and re-queues them', async () => {
    grantAll();
    apiMock.post.mockResolvedValue({ data: { deviceId: 'dev-1', deviceEmployeeId: '77', rows: 12, employeeId: E1, jobId: '42' } });
    renderWithProviders(<UnmatchedPunchesPage />, { route: '/attendance/unmatched' });
    const table = (await screen.findAllByRole('table'))[0]!;
    const row = (await within(table).findAllByRole('row')).find((r) => r.textContent?.includes('Main gate'))!;
    expect(row).toHaveTextContent('77');
    expect(row).toHaveTextContent('12');
    expect(row).toHaveTextContent('Ali Hassan');
    fireEvent.click(within(row).getByRole('button', { name: /Assign/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Device user id 77 on Main gate');
    fireEvent.click(within(dialog).getAllByRole('button', { name: /Assign/ }).at(-1)!);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/unmatched/assign', { deviceId: 'dev-1', deviceEmployeeId: '77', employeeId: E1 }));
  });

  it('ignores with a reason and restores from the Ignored tab', async () => {
    grantAll();
    apiMock.post.mockResolvedValue({ data: { deviceId: 'dev-1', deviceEmployeeId: '77', rows: 12 } });
    renderWithProviders(<UnmatchedPunchesPage />, { route: '/attendance/unmatched' });
    const table = (await screen.findAllByRole('table'))[0]!;
    const row = (await within(table).findAllByRole('row')).find((r) => r.textContent?.includes('Main gate'))!;
    fireEvent.click(within(row).getByRole('button', { name: /Ignore/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Ignore/ }));
    expect(await within(dialog).findByText('Give a reason (at least 3 characters).')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'Test enrolment' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Ignore/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/unmatched/ignore', { deviceId: 'dev-1', deviceEmployeeId: '77', reason: 'Test enrolment' }));

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Ignored' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Ignored' }));
    const ignoredTable = (await screen.findAllByRole('table'))[0]!;
    const ignored = (await within(ignoredTable).findAllByRole('row')).find((r) => r.textContent?.includes('88'))!;
    fireEvent.click(within(ignored).getByRole('button', { name: /Restore/ }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /Restore/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/unmatched/restore', { deviceId: 'dev-1', deviceEmployeeId: '88' }));
  });

  it('is read-only without device.sync', async () => {
    grant('attendance.view_raw', 'attendance.view');
    renderWithProviders(<UnmatchedPunchesPage />, { route: '/attendance/unmatched' });
    const table = (await screen.findAllByRole('table'))[0]!;
    await within(table).findAllByText('Main gate');
    expect(within(table).queryByRole('button', { name: /Assign/ })).not.toBeInTheDocument();
    expect(screen.getByText(/needs the device sync permission/)).toBeInTheDocument();
  });
});

describe('AttendancePrintPage', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat'; });

  it('prints every day of the month with the totals and signature lines', async () => {
    mockGet({
      '/orgs/org-1/attendance/calendar': { data: [{ employeeId: E1, employeeNumber: '1001', employeeName: 'Ali Hassan', branchId: 'b1', departmentId: null, joiningDate: '2025-01-01', exitDate: null, days: { '2026-08-02': { recordId: 'r', status: 'PRESENT', flags: ['LATE'], statusSource: 'MANUAL', firstInAt: '2026-08-02T04:10:00Z', lastOutAt: '2026-08-02T13:00:00Z', workedMinutes: 530, lateMinutes: 10, earlyDepartureMinutes: 0, overtimeMinutes: 0, timezone: 'Asia/Muscat' } } }], meta: { page: 1, pageSize: 1, total: 1, totalPages: 1, month: '2026-08', days: [], today: '2026-09-27' } },
      '/orgs/org-1/attendance/summary': summary,
    });
    renderWithProviders(<AttendancePrintPage />, { route: `/attendance/print?employeeId=${E1}&month=2026-08` });
    const sheet = await screen.findByTestId('print-sheet');
    expect(sheet).toHaveTextContent('Monthly attendance statement');
    expect(sheet).toHaveTextContent('Ali Hassan');
    expect(sheet.querySelectorAll('tbody tr')).toHaveLength(31);
    const day2 = sheet.querySelector('[data-day="2026-08-02"]')!;
    expect(day2).toHaveTextContent('Present');
    expect(day2).toHaveTextContent('08:10');
    expect(day2).toHaveTextContent('10m');
    expect(await screen.findByTestId('print-totals')).toHaveTextContent('20.5');
    expect(sheet).toHaveTextContent('Employee signature');
    expect(screen.getByRole('button', { name: /Print/ })).toBeEnabled();
  });

  it('asks for an employee when none is given', () => {
    renderWithProviders(<AttendancePrintPage />, { route: '/attendance/print' });
    expect(screen.getByText('No employee selected')).toBeInTheDocument();
  });
});
