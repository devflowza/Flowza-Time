import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { BRANCHES, LOC, SIMPLE_LEVELS, SIMPLE_NODES, locationRoutes } from '@/features/employees/location-test-fixtures';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import en from '@/locales/en/reports.json';
import ar from '@/locales/ar/reports.json';
import { ReportRequestPanel } from './report-request-panel';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('reports', en, ar);

/** A report for one location (docs/locations.md §2): `parameters.locationId`, wherever the report can be narrowed to a branch. */

const types = [
  { key: 'late_report', name: 'Late arrivals', description: 'Late arrivals per employee.', requiredParameters: ['from', 'to'], optionalParameters: ['branchId', 'departmentId', 'employeeIds'], permissions: ['report.view', 'attendance.view'], formats: ['csv', 'xlsx', 'pdf'], allowed: true },
  { key: 'employee_attendance', name: 'Detail Report', description: 'One page per employee.', requiredParameters: ['from', 'to', 'employeeIds'], optionalParameters: [], permissions: ['report.view', 'attendance.view'], formats: ['csv', 'xlsx', 'pdf'], allowed: true },
];
const routes = (levels = locationRoutes()) => ({ '/report-types': { data: types }, '/orgs/org-1/branches': page(BRANCHES), '/orgs/org-1/departments': page([]), '/orgs/org-1/employees': page([]), '/orgs/org-1/shifts': page([]), '/orgs/org-1/devices': page([]), ...levels });
const locationBox = () => screen.getByRole('combobox', { name: /^Location/ });

describe('ReportRequestPanel — location filter', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('sends the chosen location as parameters.locationId', async () => {
    mockGet(routes());
    apiMock.post.mockResolvedValue({ data: { id: 'rep-1', status: 'QUEUED', jobId: 'job-1' } });
    renderWithProviders(<ReportRequestPanel onQueued={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Staff Late Attendance Report/ }));
    await waitFor(() => expect(locationBox()).toHaveTextContent('All locations'));
    expect(screen.getByText('A region or branch covers its branches; a site, floor or zone covers the people working there.')).toBeInTheDocument();

    // any node: regions, branches and places
    fireEvent.click(locationBox());
    const options = within(await screen.findByRole('listbox'));
    expect(await options.findByText('Southern Region')).toBeInTheDocument();
    fireEvent.click(options.getByText('Floor 2').closest('[cmdk-item]')!);
    await waitFor(() => expect(locationBox()).toHaveTextContent('Floor 2'));

    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue report' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0] as [string, { parameters: Record<string, unknown> }];
    expect(body.parameters).toEqual({ from: '2026-09-01', to: '2026-09-30', locationId: LOC.floor2 });
  });

  it('offers no location for a report that cannot be narrowed to a branch, nor without a hierarchy', async () => {
    mockGet(routes());
    const { unmount } = renderWithProviders(<ReportRequestPanel onQueued={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Detail Report/ }));
    await screen.findByLabelText(/^From/);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/locations', undefined));
    expect(screen.queryByRole('combobox', { name: /^Location/ })).not.toBeInTheDocument();
    unmount();

    mockGet(routes(locationRoutes(SIMPLE_LEVELS, SIMPLE_NODES)));
    apiMock.post.mockResolvedValue({ data: { id: 'rep-2', status: 'QUEUED', jobId: null } });
    renderWithProviders(<ReportRequestPanel onQueued={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Staff Late Attendance Report/ }));
    await screen.findByRole('combobox', { name: /Branch/ });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/location-levels'));
    expect(screen.queryByRole('combobox', { name: /^Location/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Queue report' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect((apiMock.post.mock.calls[0] as [string, { parameters: Record<string, unknown> }])[1].parameters).not.toHaveProperty('locationId');
  });
});
