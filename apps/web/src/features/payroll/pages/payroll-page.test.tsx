import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import en from '@/locales/en/payroll.json';
import ar from '@/locales/ar/payroll.json';
import { fmtDays, fmtHm } from '@/features/attendance/status';
import PayrollPage from './payroll-page';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('payroll', en, ar);

const periods = [
  { periodStart: '2024-02-01', periodEnd: '2024-02-29', label: 'February 2024', locked: true, lockId: 'l1', lockedAt: '2024-03-02T06:00:00Z', summaries: { total: 2, draft: 2, finalized: 0, employees: 2 }, isCurrent: false },
  { periodStart: '2024-03-01', periodEnd: '2024-03-31', label: 'March 2024', locked: false, lockId: null, lockedAt: null, summaries: { total: 0, draft: 0, finalized: 0, employees: 0 }, isCurrent: true },
];
const summary = { id: 's1', employeeId: 'e1', employeeNumber: '1001', employeeName: 'Ali', departmentId: null, branchId: 'b1', branchName: 'Muscat', periodStart: '2024-02-01', periodEnd: '2024-02-29', status: 'draft', version: 1, workingDays: 21, presentDays: 19.5, absentDays: 1, leaveDays: 0.5, paidLeaveDays: 0.5, holidayDays: 1, weeklyOffDays: 8, halfDays: 1, lateDays: 3, lateMinutes: 47, earlyDepartureMinutes: 0, missingPunchDays: 0, regularMinutes: 9360, overtimeMinutes: 125, overtimeWeeklyOffMinutes: 0, overtimeHolidayMinutes: 0, recordVersions: null, computedAt: '2024-03-01T20:00:00Z', finalizedAt: null, finalizedBy: null };

describe('fmtHm / fmtDays', () => {
  it('formats minutes as h:mm and fractional days compactly', () => {
    expect(fmtHm(0)).toBe('0:00'); expect(fmtHm(125)).toBe('2:05'); expect(fmtHm(9360)).toBe('156:00'); expect(fmtHm(null)).toBe('—');
    expect(fmtDays(21)).toBe('21'); expect(fmtDays(19.5)).toBe('19.5'); expect(fmtDays(null)).toBe('—');
  });
});

describe('PayrollPage', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({ '/orgs/org-1/payroll/periods': { data: periods }, '/orgs/org-1/payroll/summaries': page([summary]), '/orgs/org-1/branches': page([]) }); });

  it('lists periods with lock status, gates Finalise behind the lock and shows summaries as h:mm / day counts', async () => {
    apiMock.post.mockResolvedValue({ data: { jobId: 'job-7', status: 'QUEUED', message: 'ok' } });
    renderWithProviders(<PayrollPage />, { route: '/payroll?period=2024-02-01_2024-02-29' });
    expect((await screen.findAllByText('February 2024')).length).toBeGreaterThan(0);
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    const finalizeButtons = screen.getAllByRole('button', { name: /Finalise/ });
    expect(finalizeButtons[0]).toBeEnabled(); // February is locked
    expect(finalizeButtons[1]).toBeDisabled(); // March is open
    // summaries of the selected (February) period, as h:mm and day counts
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/payroll/summaries', expect.objectContaining({ periodStart: '2024-02-01', periodEnd: '2024-02-29', page: 1, pageSize: 25 })));
    expect((await screen.findAllByText('Ali')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('156:00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2:05').length).toBeGreaterThan(0);
    expect(screen.getAllByText('19.5').length).toBeGreaterThan(0);

    fireEvent.click(finalizeButtons[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Finalise' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/payroll/periods/finalize', { periodStart: '2024-02-01', periodEnd: '2024-02-29', branchId: undefined }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
  });

  it('hides Finalise / Lock without the permissions', async () => {
    grant('payroll.view');
    renderWithProviders(<PayrollPage />);
    await screen.findAllByText('March 2024');
    expect(screen.queryByRole('button', { name: /Finalise/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lock period/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Build summaries/ }).length).toBeGreaterThan(0);
  });
});
