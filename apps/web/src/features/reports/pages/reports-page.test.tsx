import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import ReportsPage from './reports-page';

const report = {
  id: 'rep-1', reportType: 'late_report', format: 'pdf', parameters: { from: '2026-09-01', to: '2026-09-26' }, status: 'COMPLETED', rowCount: 12, fileSizeBytes: 2048, error: null,
  requestedBy: 'u1', requestedByName: 'Dev', createdAt: '2026-09-26T08:00:00Z', completedAt: '2026-09-26T08:00:10Z', expiresAt: '2099-01-01T00:00:00Z',
};
const routes = (extra: Record<string, unknown> = {}) => mockGet({
  '/report-types': { data: [] }, '/orgs/org-1/reports': page([report]), '/orgs/org-1/report-schedules': page([]), '/orgs/org-1/report-deliveries': page([]),
  '/orgs/org-1/report-recipients': { data: { users: [], roles: [] } }, ...extra,
});

describe('ReportsPage — report.export and schedules', () => {
  let click: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { resetApiMock(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat'; click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}); });
  afterEach(() => { click.mockRestore(); });

  it('hides Download without report.export (the API refuses it) and shows no schedules without report.schedule', async () => {
    grant('report.view');
    routes();
    renderWithProviders(<ReportsPage />, { route: '/reports' });
    const table = (await screen.findAllByRole('table'))[0]!;
    await within(table).findByText('Export not allowed');
    expect(within(table).queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('schedules-panel')).not.toBeInTheDocument();
  });

  it('downloads the report a notification points at (?download=) through the signed-in session', async () => {
    grant('report.view', 'report.export', 'report.schedule');
    routes({ '/orgs/org-1/reports/rep-1/download': { data: { url: 'https://storage.local/signed', expiresInSeconds: 300, fileName: 'late_report-2026-09-26.pdf' } } });
    renderWithProviders(<ReportsPage />, { route: '/reports?download=rep-1' });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/reports/rep-1/download', { disposition: 'attachment' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/reports$/));
    expect(await screen.findByTestId('schedules-panel')).toBeInTheDocument();
    expect((await screen.findAllByRole('button', { name: /Download/ })).length).toBeGreaterThan(0);
  });

  it('refuses a ?download= link without report.export', async () => {
    grant('report.view');
    routes();
    renderWithProviders(<ReportsPage />, { route: '/reports?download=rep-1' });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/reports$/));
    expect(apiMock.get.mock.calls.some((c) => c[0] === '/orgs/org-1/reports/rep-1/download')).toBe(false);
  });

  it('opens the report a notification points at (?view=) in the viewer — a PDF in place, fetched inline through the session', async () => {
    grant('report.view', 'report.export');
    routes({ '/orgs/org-1/reports/rep-1/download': { data: { url: 'https://storage.local/signed-inline', expiresInSeconds: 300, fileName: 'late_report-2026-09-26.pdf', disposition: 'inline' } } });
    renderWithProviders(<ReportsPage />, { route: '/reports?view=rep-1' });
    const frame = await screen.findByTestId('report-frame');
    expect(frame).toHaveAttribute('src', 'https://storage.local/signed-inline');
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/reports/rep-1/download', { disposition: 'inline' });
    expect(screen.getByRole('dialog')).toHaveTextContent('Staff Late Attendance Report');
    expect(click).not.toHaveBeenCalled(); // viewing is not downloading
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/reports$/));
  });

  it('View on a completed row opens the viewer; a CSV is shown as a table', async () => {
    grant('report.view', 'report.export');
    routes({ '/orgs/org-1/reports': page([{ ...report, format: 'csv' }]), '/orgs/org-1/reports/rep-1/download': { data: { url: 'https://storage.local/signed.csv', expiresInSeconds: 300, fileName: 'late_report-2026-09-26.csv' } } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Name,Late days\n"Al Harthy, Ahmed",3\n'));
    renderWithProviders(<ReportsPage />, { route: '/reports' });
    const table = (await screen.findAllByRole('table'))[0]!;
    (await within(table).findByRole('button', { name: /View/ })).click();
    const csv = await screen.findByTestId('report-csv');
    expect(csv).toHaveTextContent('Al Harthy, Ahmed');
    expect(fetchSpy).toHaveBeenCalledWith('https://storage.local/signed.csv');
    fetchSpy.mockRestore();
  });
});
