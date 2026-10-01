import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import en from '@/locales/en/reports.json';
import ar from '@/locales/ar/reports.json';
import { ReportRequestPanel } from './report-request-panel';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('reports', en, ar);

const types = [
  { key: 'late_report', name: 'Late arrivals', description: 'Late arrivals with minutes per employee.', requiredParameters: ['from', 'to'], optionalParameters: ['branchId', 'departmentId', 'employeeIds'], permissions: ['report.view', 'attendance.view'], formats: ['csv', 'xlsx', 'pdf'], allowed: true },
  { key: 'monthly_attendance', name: 'Monthly attendance', description: 'Per-employee day grid.', requiredParameters: ['month'], optionalParameters: ['branchId', 'layout'], permissions: ['report.view', 'attendance.view'], formats: ['csv', 'xlsx', 'pdf'], allowed: true },
  { key: 'audit_report', name: 'Audit log', description: 'Audit trail export.', requiredParameters: ['from', 'to'], optionalParameters: [], permissions: ['report.view', 'audit.view'], formats: ['csv', 'xlsx'], allowed: false },
];

describe('ReportRequestPanel', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({ '/report-types': { data: types }, '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/employees': page([]), '/orgs/org-1/shifts': page([]), '/orgs/org-1/devices': page([]) }); });

  it('lists the catalogue, disables types the user may not run, and requires the type-specific parameters before queueing (202)', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'rep-1', status: 'QUEUED', jobId: 'job-1' } });
    const onQueued = vi.fn();
    renderWithProviders(<ReportRequestPanel onQueued={onQueued} />);
    expect(await screen.findByRole('radio', { name: /Staff Late Attendance Report/ })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /Audit Trail Report/ })).toBeDisabled();
    expect(screen.getByText('Select a report type to set its parameters.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /Staff Late Attendance Report/ }));
    expect(await screen.findByText('Parameters — Staff Late Attendance Report')).toBeInTheDocument();
    // date range defaults to the current month; clearing the end date makes the required refinement fail
    const to = screen.getByLabelText(/^To/) as HTMLInputElement;
    expect(to.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.change(to, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue report' }));
    await screen.findByText('Required');
    expect(apiMock.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2024-03-01' } });
    fireEvent.change(to, { target: { value: '2024-03-31' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Format/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'CSV' }));
    fireEvent.click(screen.getByRole('button', { name: 'Queue report' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body, opts] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/reports');
    expect(body).toEqual({ reportType: 'late_report', format: 'csv', parameters: { from: '2024-03-01', to: '2024-03-31' } });
    expect(opts).toMatchObject({ idempotencyKey: expect.any(String) });
    await waitFor(() => expect(onQueued).toHaveBeenCalledWith('rep-1'));
  });

  it('asks for the leave type when the report needs one, sends its code, and pre-selects the layout\'s format', async () => {
    mockGet({
      '/report-types': { data: [{ key: 'leave_report', name: 'Staff Leave Report', description: 'One leave type per department.', requiredParameters: ['from', 'to', 'leaveTypeCode'], optionalParameters: ['branchId', 'departmentId'], permissions: ['report.view', 'attendance.view', 'leave.view'], formats: ['csv', 'xlsx', 'pdf'], allowed: true, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' }] },
      '/orgs/org-1/leave-types': { data: [{ id: 'lt-1', code: 'CL', name: 'Casual Leave', nameAr: null, isPaid: true, color: null, status: 'active', createdAt: '2024-01-01T00:00:00Z' }] },
      '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/employees': page([]), '/orgs/org-1/shifts': page([]), '/orgs/org-1/devices': page([]),
    });
    apiMock.post.mockResolvedValue({ data: { id: 'rep-2', status: 'QUEUED', jobId: null } });
    renderWithProviders(<ReportRequestPanel onQueued={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Staff Leave Report/ }));
    // a print layout opens on PDF, not on the spreadsheet default
    expect(await screen.findByRole('combobox', { name: /Format/ })).toHaveTextContent('PDF');
    fireEvent.click(screen.getByRole('combobox', { name: /Leave type/ }));
    const opt = await screen.findByText('Casual Leave');
    fireEvent.click(opt.closest('[cmdk-item]') ?? opt);
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Leave type/ })).toHaveTextContent('Casual Leave'));
    fireEvent.click(screen.getByRole('button', { name: 'Queue report' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const body = (apiMock.post.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(body).toMatchObject({ reportType: 'leave_report', format: 'pdf' });
    expect((body.parameters as Record<string, unknown>).leaveTypeCode).toBe('CL');
  });

  it('6a-ATT21 the Daily Report is one day by default and takes an optional range of at most 62 days', async () => {
    mockGet({
      '/report-types': { data: [{ key: 'daily_attendance', name: 'Daily Report', description: 'Every employee on one day.', requiredParameters: ['from'], optionalParameters: ['to', 'branchId', 'departmentId'], permissions: ['report.view', 'attendance.view'], formats: ['csv', 'xlsx', 'pdf'], allowed: true, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' }] },
      '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/employees': page([]), '/orgs/org-1/shifts': page([]), '/orgs/org-1/devices': page([]),
    });
    apiMock.post.mockResolvedValue({ data: { id: 'rep-3', status: 'QUEUED', jobId: 'job-3' } });
    renderWithProviders(<ReportRequestPanel onQueued={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Daily Report/ }));
    const from = await screen.findByLabelText(/^From/) as HTMLInputElement;
    const to = screen.getByLabelText(/^To/) as HTMLInputElement;
    expect(from.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to.value).toBe(''); // one day unless a range is asked for
    expect(screen.getByText(/at most 62 days/)).toBeInTheDocument();
    fireEvent.change(from, { target: { value: '2026-06-01' } });
    fireEvent.change(to, { target: { value: '2026-08-02' } }); // 63 days
    fireEvent.click(screen.getByRole('button', { name: 'Queue report' }));
    expect(await screen.findByText('The Daily Report covers at most 62 days.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.change(from, { target: { value: '2026-06-02' } }); // 62 days
    fireEvent.click(screen.getByRole('button', { name: 'Queue report' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect((apiMock.post.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ reportType: 'daily_attendance', parameters: { from: '2026-06-02', to: '2026-08-02' } });
  });

  it('shows a month picker for month-based reports', async () => {
    renderWithProviders(<ReportRequestPanel onQueued={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Monthly Attendance Report/ }));
    expect((await screen.findByLabelText(/Month/) as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}$/);
    expect(screen.queryByLabelText(/^From/)).not.toBeInTheDocument();
  });

  it('offers the Monthly Attendance Report\'s Detailed layout (each day\'s IN/OUT and hours) and sends it; Summary stays the default', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'rep-2', status: 'QUEUED', jobId: 'job-2' } });
    renderWithProviders(<ReportRequestPanel onQueued={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Monthly Attendance Report/ }));
    const layout = await screen.findByRole('combobox', { name: /Layout/ });
    expect(layout).toHaveTextContent('Summary — attendance code per day');
    fireEvent.keyDown(layout, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Detailed — IN/OUT times and hours per day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Queue report' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0] as [string, { parameters: Record<string, unknown> }];
    expect(body.parameters).toEqual({ month: expect.stringMatching(/^\d{4}-\d{2}$/), layout: 'detailed' });
  });
});
