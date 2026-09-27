import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/leave.json';
import ar from '@/locales/ar/leave.json';
import LeavePage from './leave-page';

registerNamespace('leave', en, ar);

const TYPE = '22222222-2222-4222-8222-222222222222';
const pending = { id: 'l1', employeeId: 'e1', employeeNumber: 'MG-1012', employeeName: 'Priya Sharma', leaveTypeId: TYPE, leaveTypeName: 'Annual Leave', branchId: null, startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false, halfDayPart: null, reason: 'Diwali in Kerala', status: 'PENDING', source: 'INTERNAL', decisionNote: null, approvedBy: null, approvedAt: null, createdBy: 'u9', createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T06:00:00Z' };

describe('LeavePage — self-service requests', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({ '/orgs/org-1/leave-records': page([pending]), '/orgs/org-1/leave-types': { data: [{ id: TYPE, code: 'AL', name: 'Annual Leave', nameAr: null, isPaid: true, treatAsPresent: false, color: '#175cd3', annualAllowanceDays: 30, status: 'active', createdAt: '' }] }, '/orgs/org-1/employees': page([]), '/orgs/org-1/branches': page([]) });
  });

  it('approves a pending request with a note for the employee', async () => {
    apiMock.patch.mockResolvedValue({ data: { ...pending, status: 'APPROVED', recalculationJobId: null } });
    renderWithProviders(<LeavePage />, { route: '/leave' });
    fireEvent.click((await screen.findAllByRole('button', { name: /Approve/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Diwali in Kerala/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Note to the employee/), { target: { value: 'Enjoy the festival' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/leave-records/l1', { status: 'APPROVED', decisionNote: 'Enjoy the festival' }));
  });

  it('rejects without a note (sent as null)', async () => {
    apiMock.patch.mockResolvedValue({ data: { ...pending, status: 'REJECTED', recalculationJobId: null } });
    renderWithProviders(<LeavePage />, { route: '/leave' });
    fireEvent.click((await screen.findAllByRole('button', { name: /Reject/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/leave-records/l1', { status: 'REJECTED', decisionNote: null }));
  });
});
