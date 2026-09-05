import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/leave.json';
import ar from '@/locales/ar/leave.json';
import { LeaveRecordDialog } from './leave-record-dialog';

registerNamespace('leave', en, ar);

const EMP = '11111111-1111-4111-8111-111111111111';
const TYPE = '22222222-2222-4222-8222-222222222222';

describe('LeaveRecordDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({ '/orgs/org-1/employees': page([]), '/orgs/org-1/leave-types': { data: [{ id: TYPE, code: 'AL', name: 'Annual', nameAr: null, isPaid: true, color: null, status: 'active', createdAt: '' }] } }); });

  it('rejects an end date before the start date (leaveRecordInputSchema refine) and posts a half-day record', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'l1', recalculationJobId: null } });
    const onOpenChange = vi.fn();
    renderWithProviders(<LeaveRecordDialog open onOpenChange={onOpenChange} preset={{ employeeId: EMP, leaveTypeId: TYPE, startDate: '2024-03-10', endDate: '2024-03-12' }} />);
    fireEvent.change(screen.getByLabelText(/End date/), { target: { value: '2024-03-09' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record leave' }));
    await screen.findByText('endDate must be on/after startDate');
    expect(apiMock.post).not.toHaveBeenCalled();

    // half day: end date follows the start date and the half selector appears
    fireEvent.click(screen.getByRole('switch', { name: /Half day/ }));
    expect(screen.getByLabelText(/End date/)).toHaveValue('2024-03-10');
    expect(screen.getByLabelText(/End date/)).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /Which half/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Doctor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record leave' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/leave-records', { employeeId: EMP, leaveTypeId: TYPE, startDate: '2024-03-10', endDate: '2024-03-10', isHalfDay: true, halfDayPart: 'FIRST_HALF', reason: 'Doctor' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
