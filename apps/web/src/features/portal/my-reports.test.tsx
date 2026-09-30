import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { Sidebar } from '@/components/layout/sidebar';
import './routes';
import MyReportsPage from './pages/reports-page';

const EMP = '11111111-1111-4111-8111-111111111111';
// the copy of a monthly report about the employee, shared with them by HR (self scope)
const mine = {
  id: 'rep-9', reportType: 'monthly_attendance', format: 'pdf', parameters: { month: '2026-09', employeeIds: [EMP] }, status: 'COMPLETED', rowCount: 1, fileSizeBytes: 900, error: null,
  requestedBy: 'u1', requestedByName: 'Me', createdAt: '2026-09-29T20:10:00Z', completedAt: '2026-09-29T20:10:30Z', expiresAt: '2099-01-01T00:00:00Z',
};

beforeEach(() => { resetApiMock(); grant('attendance.view_own'); testState.orgId = 'org-1'; testState.employeeId = EMP; testState.timezone = 'Asia/Muscat'; });

describe('portal — My reports (each employee receives the report about themselves)', () => {
  it('is in "My workspace"', () => {
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: 'My reports' })).toHaveAttribute('href', '/my/reports');
  });

  it('lists the reports sent to the employee with View and Download', async () => {
    mockGet({ '/orgs/org-1/me/reports': page([mine]) });
    renderWithProviders(<MyReportsPage />, { route: '/my/reports' });
    const table = (await screen.findAllByRole('table'))[0]!;
    expect(await within(table).findByText('Monthly Attendance Report')).toBeInTheDocument();
    expect(within(table).getByText('September 2026')).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: /View/ })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('opens the notification link (?view=) in the viewer through the employee\'s own session', async () => {
    mockGet({ '/orgs/org-1/me/reports': page([mine]), '/orgs/org-1/reports/rep-9/download': { data: { url: 'https://storage.local/mine.pdf', expiresInSeconds: 300, fileName: 'monthly_attendance-2026-09-29.pdf' } } });
    renderWithProviders(<MyReportsPage />, { route: '/my/reports?view=rep-9' });
    expect(await screen.findByTestId('report-frame')).toHaveAttribute('src', 'https://storage.local/mine.pdf');
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/reports/rep-9/download', { disposition: 'inline' });
    expect(screen.getByRole('dialog')).toHaveTextContent('Monthly Attendance Report');
  });

  it('says what the page is for when nothing was sent yet', async () => {
    mockGet({ '/orgs/org-1/me/reports': page([]) });
    renderWithProviders(<MyReportsPage />, { route: '/my/reports' });
    expect((await screen.findAllByText('No reports yet')).length).toBeGreaterThan(0);
  });
});
