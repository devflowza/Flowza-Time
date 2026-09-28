import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import type { ReportDeliveryDto, ReportScheduleDto } from '@flowza/contracts';
import { SchedulesPanel } from './schedules-panel';
import { ShareReportDialog } from './share-report-dialog';
import { allowedPeriodRules, skipReasonLabel } from '../schedule-utils';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const types = [
  { key: 'monthly_attendance', name: 'Monthly Attendance Report', description: 'd', requiredParameters: ['month'], optionalParameters: ['branchId', 'departmentId', 'employeeIds'], permissions: ['report.view', 'attendance.view'], formats: ['csv', 'xlsx', 'pdf'], status: 'available', defaultFormat: 'pdf', allowed: true },
  { key: 'late_report', name: 'Staff Late Attendance Report', description: 'd', requiredParameters: ['from', 'to'], optionalParameters: ['branchId', 'departmentId'], permissions: ['report.view', 'attendance.view'], formats: ['csv', 'xlsx', 'pdf'], status: 'available', defaultFormat: 'pdf', allowed: true },
  { key: 'daily_attendance', name: 'Daily Report', description: 'd', requiredParameters: ['from'], optionalParameters: [], permissions: ['report.view', 'attendance.view'], formats: ['pdf'], status: 'available', defaultFormat: 'pdf', allowed: true },
];
const schedule: ReportScheduleDto = {
  id: 's1', name: 'Monthly for managers', reportType: 'monthly_attendance', format: 'pdf', filters: {}, branchId: null, cadence: 'monthly', runDay: 1, runTime: '07:00:00', periodRule: 'previous_month',
  customFromDay: null, customToDay: null, recipients: { userIds: [U1], roleKeys: ['hr_admin'] }, channels: ['in_app', 'email'], isActive: true, nextRunAt: '2026-10-01T03:00:00Z', lastRunAt: '2026-09-01T03:00:05Z',
  lastStatus: 'partial', lastError: null, lastSummary: { period: { from: '2026-08-01', to: '2026-08-31' }, recipients: 3, queued: 2, skipped: 1, failed: 0 }, nextPeriod: { from: '2026-09-01', to: '2026-09-30' },
  timezone: 'Asia/Muscat', createdBy: U2, createdByName: 'Owner', createdAt: '2026-08-20T10:00:00Z', updatedAt: '2026-08-20T10:00:00Z',
};
const delivery = (over: Partial<ReportDeliveryDto>): ReportDeliveryDto => ({
  id: 'd1', scheduleId: 's1', scheduleName: 'Monthly for managers', mode: 'schedule', reportType: 'monthly_attendance', format: 'pdf', periodFrom: '2026-08-01', periodTo: '2026-08-31', recipientUserId: U1, recipientName: 'Maha Manager',
  sentBy: null, sentByName: null, channels: ['in_app', 'email'], scope: { kind: 'TEAM', employeeCount: 4 }, status: 'delivered', skipReason: null, error: null, reportRequestId: 'rr1', createdAt: '2026-09-01T03:00:05Z', deliveredAt: '2026-09-01T03:01:00Z', ...over,
});
const recipients = {
  data: {
    users: [
      { userId: U1, displayName: 'Maha Manager', email: 'maha@x.om', roleKey: 'manager', roleName: 'Manager', isManager: true, branchCount: null },
      { userId: U2, displayName: 'Omar Owner', email: 'omar@x.om', roleKey: 'owner', roleName: 'Owner', isManager: false, branchCount: null },
    ],
    roles: [{ key: 'hr_admin', name: 'HR admin', members: 2 }, { key: 'manager', name: 'Manager', members: 5 }],
  },
};

describe('schedule helpers', () => {
  it('only offers the periods the report and the frequency allow', () => {
    expect(allowedPeriodRules('monthly', 'monthly_attendance')).toEqual(['previous_month', 'month_to_date']);
    expect(allowedPeriodRules('weekly', 'monthly_attendance')).toEqual(['month_to_date']);
    expect(allowedPeriodRules('monthly', 'late_report')).toEqual(['previous_month', 'month_to_date', 'custom']);
    expect(allowedPeriodRules('weekly', 'weekly_attendance')).toEqual(['previous_week']);
    expect(allowedPeriodRules('monthly', 'weekly_attendance')).toEqual([]);
    const t = (k: string, o?: Record<string, unknown>) => `${k}|${String(o?.['detail'] ?? '')}`;
    expect(skipReasonLabel(t, 'missing_permission:report.export')).toBe('skip.missing_permission|report.export');
    expect(skipReasonLabel(t, null)).toBe('');
  });
});

describe('SchedulesPanel', () => {
  beforeEach(() => {
    resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat';
    mockGet({
      '/orgs/org-1/report-schedules': page([schedule]),
      '/orgs/org-1/report-deliveries': page([delivery({}), delivery({ id: 'd2', recipientUserId: U2, recipientName: 'Hana HR', status: 'skipped', skipReason: 'missing_permission:report.export', scope: {}, reportRequestId: null })]),
      '/orgs/org-1/report-recipients': recipients, '/report-types': { data: types },
      '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/employees': page([]), '/orgs/org-1/leave-types': { data: [] },
    });
  });

  it('lists schedules with their cadence and next period, and the per-recipient delivery log', async () => {
    renderWithProviders(<SchedulesPanel />);
    const panel = await screen.findByTestId('schedules-panel');
    const scheduleRow = (await within(panel).findAllByText('Monthly on day 1 at 07:00 · Previous month')).map((e) => e.closest('tr')).find(Boolean)!;
    expect(scheduleRow).toHaveTextContent('Monthly for managers');
    expect(scheduleRow).toHaveTextContent('Partly sent');
    expect(scheduleRow).toHaveTextContent('2 sent · 1 skipped');
    expect(scheduleRow).toHaveTextContent('1 people · 1 roles');
    const log = within(panel).getAllByRole('table').at(-1)!;
    const rows = await within(log).findAllByRole('row');
    expect(rows.find((r) => r.textContent?.includes('Maha Manager'))).toHaveTextContent('Their team (4)');
    const skipped = rows.find((r) => r.textContent?.includes('Hana HR'))!;
    expect(skipped).toHaveTextContent('Skipped');
    expect(skipped).toHaveTextContent('No access to this report (report.export)');
  });

  it('runs a schedule now', async () => {
    apiMock.post.mockResolvedValue({ data: { jobId: '9', runKey: 'manual:x', status: 'QUEUED', period: { from: '2026-09-01', to: '2026-09-26' } } });
    renderWithProviders(<SchedulesPanel />);
    const panel = await screen.findByTestId('schedules-panel');
    const row = (await within(panel).findAllByText('Monthly on day 1 at 07:00 · Previous month')).map((e) => e.closest('tr')).find(Boolean)!;
    fireEvent.click(within(row).getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/report-schedules/s1/run-now', undefined, expect.objectContaining({ idempotencyKey: expect.any(String) })));
  });

  it('creates a schedule: whole-month periods only for a month report, and at least one recipient', async () => {
    apiMock.post.mockResolvedValue({ data: { ...schedule, id: 's2' } });
    renderWithProviders(<SchedulesPanel />);
    const panel = await screen.findByTestId('schedules-panel');
    fireEvent.click(within(panel).getAllByRole('button', { name: /New schedule/ })[0]!);
    const dialog = await screen.findByTestId('schedule-dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'HR monthly' } });
    // a month report offers previous month / month to date only
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Period covered' }), { key: 'ArrowDown' });
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['Previous month', 'Month to date']);
    fireEvent.click(screen.getByRole('option', { name: 'Previous month' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create schedule' }));
    expect(await within(dialog).findByText('Choose at least one recipient.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
    await within(dialog).findByRole('button', { name: /HR admin/ });
    fireEvent.click(within(dialog).getByRole('button', { name: /HR admin/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/report-schedules');
    expect(body).toMatchObject({ name: 'HR monthly', reportType: 'monthly_attendance', format: 'pdf', cadence: 'monthly', runDay: 1, runTime: '07:00', periodRule: 'previous_month', recipients: { userIds: [], roleKeys: ['hr_admin'] }, channels: ['in_app', 'email'], isActive: true, filters: {} });
  });
});

describe('ShareReportDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; mockGet({ '/orgs/org-1/report-recipients': recipients }); });

  it('sends the configured report to the chosen recipients, each under their own scope', async () => {
    apiMock.post.mockResolvedValue({ data: { jobId: '7', runKey: 'send:x', status: 'QUEUED', recipients: 1 } });
    const onClose = vi.fn();
    renderWithProviders(<ShareReportDialog spec={{ reportType: 'late_report', format: 'pdf', parameters: { from: '2026-09-01', to: '2026-09-26' }, title: 'Staff Late Attendance Report' }} onClose={onClose} />);
    const dialog = await screen.findByTestId('share-dialog');
    expect(await within(dialog).findByText(/Each recipient gets the report for the data they can access/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Send$/ }));
    expect(await within(dialog).findByText('Choose at least one recipient.')).toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Maha Manager' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Email/ }));
    fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: 'For your review' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/reports/share');
    expect(body).toEqual({ reportType: 'late_report', format: 'pdf', parameters: { from: '2026-09-01', to: '2026-09-26' }, recipients: { userIds: [U1], roleKeys: [] }, channels: ['in_app'], note: 'For your review' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
