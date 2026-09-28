import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() }, toastError: vi.fn(), toastQueued: vi.fn() }));

import type { SelfLeaveDto } from '@flowza/contracts';
import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { toast } from '@/lib/toast';
import './routes';
import { previewCalendarOf, previewLeaveDaysByMode } from '@/features/leave/model';
import { ApplyLeaveDialog } from './components/apply-leave-dialog';
import { WithdrawLeaveDialog } from './components/leave-parts';

/**
 * Leave v2 review fixes in the portal (docs/hr-portal/reviews/07-leave-v2-review.md): the apply form counts with the
 * per-date working calendar (7-P1-1 / 7-P1-2), checks the balance of the leave's own year (7-P2-9), says "1 day" (plurals),
 * and a second withdrawal is not an error (7-P2-12).
 */
const EMP = '11111111-1111-4111-8111-111111111111';
const AL = '22222222-2222-4222-8222-222222222222';
const record = (over: Partial<SelfLeaveDto['records'][number]> = {}): SelfLeaveDto['records'][number] => ({
  id: 'l1', leaveTypeId: AL, leaveTypeCode: 'AL', leaveTypeName: 'Annual Leave', color: '#175cd3', isPaid: true, startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false, halfDayPart: null, days: 5,
  reason: 'Family visit', status: 'PENDING', decisionNote: null, approvedByName: null, approvedAt: null, createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T06:00:00Z',
  approvalRequestId: null, approvalStatus: null, approvalCurrentStep: null, approvalStepCount: null, canWithdraw: true, ...over,
});
const yearData = (year: number, availableAfterPendingDays: number, calendar: SelfLeaveDto['calendar'] = { weeklyOffDays: [5, 6], holidays: [] }): SelfLeaveDto => ({
  year,
  types: [{ id: AL, code: 'AL', name: 'Annual Leave', nameAr: null, isPaid: true, color: '#175cd3', annualAllowanceDays: 20 }],
  balances: [{ leaveTypeId: AL, allowanceDays: 20, usedDays: 0, pendingDays: 0, remainingDays: availableAfterPendingDays, tracked: true, availableAfterPendingDays } as never],
  records: [],
  calendar,
});

beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.employeeId = EMP; vi.mocked(toast.info).mockReset(); vi.mocked(toast.error).mockReset(); vi.mocked(toast.success).mockReset(); });

async function pickAnnualLeave() {
  fireEvent.keyDown(screen.getByRole('combobox', { name: /Leave type/ }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: /Annual Leave/ }));
}

describe('7-P2-9 the apply form checks the balance of the leave\'s own year', () => {
  it('7-P2-9 a request in January next year is checked against next year\'s balance, not the displayed year\'s (BAL-5 / T4)', async () => {
    mockGet({ '/orgs/org-1/me/leave': (q: Record<string, unknown> | undefined) => ({ data: yearData(Number(q?.['year']), 17) }) });
    renderWithProviders(<ApplyLeaveDialog open onOpenChange={vi.fn()} data={yearData(2026, 1)} />);
    await pickAnnualLeave();
    // Sun 3 – Tue 5 January 2027: three working days
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: '2027-01-03' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2027-01-05' } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/me/leave', { year: 2027 }));
    const preview = await screen.findByText('14 days of Annual Leave left after this request.');
    expect(preview).toBeInTheDocument();
    expect(screen.getByTestId('leave-preview')).not.toHaveTextContent('more than your remaining');
  });

  it('keeps the displayed year\'s balance for dates inside it (no extra call)', async () => {
    mockGet({ '/orgs/org-1/me/leave': () => ({ data: yearData(2027, 17) }) });
    renderWithProviders(<ApplyLeaveDialog open onOpenChange={vi.fn()} data={yearData(2026, 1)} />);
    await pickAnnualLeave();
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: '2026-10-04' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-10-06' } });
    // "(1 day)", never "(1 days)"
    expect(screen.getByTestId('leave-preview')).toHaveTextContent('more than your remaining Annual Leave balance (1 day).');
    expect(apiMock.get).not.toHaveBeenCalledWith('/orgs/org-1/me/leave', expect.anything());
  });
});

describe('7-P1-1 / 7-P1-2 the apply form counts with the per-date working calendar', () => {
  it('7-P1-1 a date the per-date calendar marks off (a rotation off day, another branch\'s weekly off) is not counted', async () => {
    // Sun 4 – Thu 8 Oct: the Thursday is a rostered-off day of the employee (offDates), although not a Friday or Saturday
    const cal = { weeklyOffDays: [5, 6], holidays: [], offDates: ['2026-10-08', '2026-10-09', '2026-10-10'], from: '2026-01-01', to: '2027-12-31' };
    renderWithProviders(<ApplyLeaveDialog open onOpenChange={vi.fn()} data={yearData(2026, 20, cal)} />);
    await pickAnnualLeave();
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: '2026-10-04' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-10-08' } });
    expect(screen.getByTestId('leave-preview')).toHaveTextContent('This request uses 4 working days.');
  });

  it('7-P1-1 the per-date off days decide inside the range they cover; outside it the weekly offs and holidays do', () => {
    const cal = previewCalendarOf({ weeklyOffDays: [5, 6], holidays: ['2028-01-02'], offDates: ['2026-10-08'], from: '2026-01-01', to: '2027-12-31' });
    // Sun 4 – Thu 8 Oct 2026: the rostered-off Thursday is free, the Friday-Saturday rule is not consulted inside the range
    expect(previewLeaveDaysByMode('2026-10-04', '2026-10-08', false, cal)).toBe(4);
    expect(previewLeaveDaysByMode('2026-10-09', '2026-10-10', false, cal)).toBe(2);
    // Sun 2 – Sat 8 Jan 2028 lies past the covered range: the holiday on the 2nd and Friday + Saturday are free
    expect(previewLeaveDaysByMode('2028-01-02', '2028-01-08', false, cal)).toBe(4);
    // an older API answer without offDates keeps the weekly offs and holidays
    expect(previewLeaveDaysByMode('2026-10-04', '2026-10-10', false, previewCalendarOf({ weeklyOffDays: [5, 6], holidays: [] }))).toBe(5);
  });
});

describe('7-P2-12 withdrawing an already withdrawn request', () => {
  it('7-P2-12 says "already withdrawn" as information, not as an error', async () => {
    apiMock.post.mockResolvedValue({ data: { ...record(), status: 'CANCELLED', alreadyWithdrawn: true } });
    const onClose = vi.fn();
    renderWithProviders(<WithdrawLeaveDialog record={record()} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/Why are you withdrawing it/), { target: { value: 'Plans changed' } });
    fireEvent.click(screen.getByRole('button', { name: /Withdraw/ }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('This request was already withdrawn.'));
    expect(toast.error).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
