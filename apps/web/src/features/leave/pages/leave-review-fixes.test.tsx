import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() }, toastError: vi.fn(), toastQueued: vi.fn() }));

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { toast } from '@/lib/toast';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/leave.json';
import ar from '@/locales/ar/leave.json';
import '@/features/approvals/routes';
import { approvalRequest, approvalStep, leaveContext } from '@/features/approvals/test-fixtures';
import LeavePage from './leave-page';
import { TeamUpcomingLeave } from '../components/team-upcoming-leave';
import { RequestDetail } from '@/features/approvals/components/request-detail';

registerNamespace('leave', en, ar);

/**
 * Leave v2 review fixes on the HR Leave page (docs/hr-portal/reviews/07-leave-v2-review.md): the seat choice of an override
 * (engine §9.8), the year-close toast (7-P2-6), the calendar total of the month (7-P2-8), employment-type applicability on
 * the Types tab (7-P1-3, B-41) and the team card on /my (7-P2-7).
 */
const AL = '22222222-2222-4222-8222-222222222222';
const EMP = '44444444-4444-4444-8444-444444444444';
const types = [
  { id: AL, code: 'AL', name: 'Annual Leave', nameAr: null, isPaid: true, treatAsPresent: false, color: '#175cd3', annualAllowanceDays: 30, status: 'active', createdAt: '', requiresApproval: true, countMode: 'working', advanceNoticeDays: 0, maxConsecutiveDays: null, carryForwardMaxDays: 0, applicableGender: 'all', applicableEmploymentTypes: null, accrual: 'none', portalVisible: true, isSpecial: false, compOff: false },
  { id: 'ct', code: 'CT', name: 'Contract Leave', nameAr: null, isPaid: true, treatAsPresent: false, color: '#0e7490', annualAllowanceDays: 6, status: 'active', createdAt: '', requiresApproval: true, countMode: 'working', advanceNoticeDays: 0, maxConsecutiveDays: null, carryForwardMaxDays: 0, applicableGender: 'all', applicableEmploymentTypes: ['contract', 'temporary'], accrual: 'none', portalVisible: true, isSpecial: false, compOff: false },
];
const record = (over: Record<string, unknown> = {}) => ({
  id: 'l1', employeeId: EMP, employeeNumber: 'MG-1012', employeeName: 'Priya Sharma', leaveTypeId: AL, leaveTypeName: 'Annual Leave', branchId: null, startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false, halfDayPart: null,
  reason: 'Diwali in Kerala', status: 'PENDING', source: 'SELF_SERVICE', decisionNote: null, approvedBy: null, approvedAt: null, createdBy: 'u9', createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T06:00:00Z',
  days: 4, withdrawnAt: null, editedAt: null, approvalRequestId: 'req-9', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1, approvalWaitingFor: ['Aisha', 'Badr'], commentCount: 0, ...over,
});
const seatRequest = (mustChooseSeat: boolean) => approvalRequest({
  id: 'req-9', entityType: 'LEAVE', employeeName: 'Priya Sharma', currentStep: 1, stepCount: 1, context: leaveContext(),
  steps: [approvalStep({ requestId: 'req-9', mode: 'ALL', requiredCount: 2, pendingSeats: [{ userId: 'u-a', userName: 'Aisha' }, { userId: 'u-b', userName: 'Badr' }], actors: [] })],
  abilities: { canDecide: true, canCancel: true, canReassign: false, canBypass: false, canRequestInfo: true, canAnswerInfo: false, actingAsDelegateOf: null, decideVia: 'override', mustChooseSeat },
});

beforeEach(() => {
  resetApiMock(); grantAll();
  vi.mocked(toast.success).mockReset(); vi.mocked(toast.error).mockReset();
  mockGet({
    '/orgs/org-1/leave-records': page([record()]),
    '/orgs/org-1/leave-types': { data: types },
    '/orgs/org-1/employees': page([]),
    '/orgs/org-1/branches': page([]),
    '/orgs/org-1/departments': page([]),
    '/orgs/org-1/approvals/req-9': { data: seatRequest(true) },
    '/orgs/org-1/leave-allocations': page([]),
    '/orgs/org-1/leave-calendar': { data: { month: '2026-09', from: '2026-09-01', to: '2026-09-30', truncated: false, employees: [{ employeeId: EMP, employeeName: 'Priya Sharma', employeeNumber: 'MG-1012', branchId: null, departmentId: null }], entries: [
      // Sun 27 Sep – Thu 8 Oct: 10 days, 4 of them in September; and a 2-day leave stored before leave v2 (days computed on read)
      { id: 'l1', employeeId: EMP, employeeName: 'Priya Sharma', employeeNumber: 'MG-1012', leaveTypeId: AL, leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', color: '#175cd3', startDate: '2026-09-27', endDate: '2026-10-08', isHalfDay: false, halfDayPart: null, days: 10, daysInPeriod: 4, status: 'APPROVED' },
      { id: 'l2', employeeId: EMP, employeeName: 'Priya Sharma', employeeNumber: 'MG-1012', leaveTypeId: AL, leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', color: '#175cd3', startDate: '2026-09-06', endDate: '2026-09-07', isHalfDay: false, halfDayPart: null, days: 2, daysInPeriod: 2, status: 'APPROVED' },
    ] } },
  });
});

describe('seat choice on the Leave page (engine §9.8)', () => {
  it('an override on a level waiting for several approvers names whose seat it fills ("Deciding for")', async () => {
    apiMock.patch.mockResolvedValue({ data: { ...record(), approvalWaitingFor: ['Aisha'], recalculationJobId: null } });
    renderWithProviders(<LeavePage />, { route: '/leave' });
    fireEvent.click((await screen.findAllByRole('button', { name: /^Approve/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    const seat = await within(dialog).findByRole('combobox', { name: /Deciding for/ });
    const approve = within(dialog).getByRole('button', { name: /Approve/ });
    expect(approve).toBeDisabled();
    fireEvent.keyDown(seat, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Badr' }));
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/leave-records/l1', { status: 'APPROVED', decisionNote: null, stepNo: 1, onBehalfOfUserId: 'u-b' }));
  });

  it('asks nothing when the request does not need a seat named', async () => {
    mockGet({ '/orgs/org-1/leave-records': page([record()]), '/orgs/org-1/leave-types': { data: types }, '/orgs/org-1/employees': page([]), '/orgs/org-1/branches': page([]), '/orgs/org-1/approvals/req-9': { data: seatRequest(false) } });
    apiMock.patch.mockResolvedValue({ data: { ...record(), recalculationJobId: null } });
    renderWithProviders(<LeavePage />, { route: '/leave' });
    fireEvent.click((await screen.findAllByRole('button', { name: /^Approve/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(apiMock.get.mock.calls.some((c) => c[0] === '/orgs/org-1/approvals/req-9')).toBe(true));
    expect(within(dialog).queryByRole('combobox', { name: /Deciding for/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/leave-records/l1', { status: 'APPROVED', decisionNote: null, stepNo: 1 }));
  });
});

describe('7-P2-6 the year-close toast', () => {
  it('7-P2-6 "View" opens the allocations of the year filled, never /sync/<queue job id>', async () => {
    apiMock.post.mockResolvedValue({ data: { jobId: '12121212', status: 'QUEUED', fromYear: 2025, toYear: 2026 } });
    renderWithProviders(<LeavePage />, { route: '/leave?tab=allocations&year=2026' });
    fireEvent.click(await screen.findByRole('button', { name: /Close 2025 → 2026/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Close 2025 → 2026/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const opts = vi.mocked(toast.success).mock.calls.at(-1)![1] as { action?: { onClick: () => void } };
    expect(opts.action).toBeDefined();
    opts.action!.onClick();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/leave?tab=allocations&year=2026'));
    expect(screen.getByTestId('location')).not.toHaveTextContent('/sync/');
  });
});

describe('7-P2-8 the team calendar total', () => {
  it('7-P2-8 sums the days inside the month (4 + 2), not the full days of a leave that overlaps it (10 + 2)', async () => {
    renderWithProviders(<LeavePage />, { route: '/leave?tab=calendar&month=2026-09' });
    const row = (await screen.findByRole('rowheader', { name: /Priya Sharma/ })).closest('tr')!;
    expect(row.lastElementChild).toHaveTextContent(/^6$/);
  });
});

describe('7-P1-3 employment-type applicability on the Types tab (B-41)', () => {
  it('7-P1-3 shows the employment types a type is for, and saves the ticked ones with a new type', async () => {
    apiMock.post.mockResolvedValue({ data: { ...types[0], id: 'new', code: 'ST', name: 'Study Leave', applicableEmploymentTypes: ['intern'] } });
    renderWithProviders(<LeavePage />, { route: '/leave?tab=types' });
    const row = (await screen.findByText('Contract Leave')).closest('tr')!;
    expect(within(row).getByText('Contract / Temporary only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add leave type/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(dialog.querySelector('#lt-code')!, { target: { value: 'ST' } });
    fireEvent.change(dialog.querySelector('#lt-name')!, { target: { value: 'Study Leave' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Intern' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/leave-types', expect.objectContaining({ code: 'ST', applicableEmploymentTypes: ['intern'] })));
  });
});

describe('7-P2-7 the team card on /my', () => {
  it('7-P2-7 is hidden when the team has no upcoming leave, shown when it has some', async () => {
    testState.teamSize = 2;
    mockGet({ '/orgs/org-1/me/team/leave': { data: [] } });
    const { container, unmount } = renderWithProviders(<TeamUpcomingLeave />);
    await waitFor(() => expect(apiMock.get.mock.calls.some((c) => c[0] === '/orgs/org-1/me/team/leave')).toBe(true));
    await waitFor(() => expect(container.querySelector('h2')).toBeNull());
    expect(screen.queryByText('No upcoming leave in your team')).not.toBeInTheDocument();
    unmount();
    mockGet({ '/orgs/org-1/me/team/leave': { data: [{ id: 't1', employeeId: EMP, employeeName: 'Priya Sharma', employeeNumber: 'MG-1012', leaveTypeId: AL, leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', color: '#175cd3', startDate: '2026-10-04', endDate: '2026-10-04', isHalfDay: false, halfDayPart: null, days: 1, status: 'APPROVED' }] } });
    renderWithProviders(<TeamUpcomingLeave />);
    expect(await screen.findByText('Team leave')).toBeInTheDocument();
    expect(await screen.findByText(/· 1 day$/)).toBeInTheDocument();
    testState.teamSize = 0;
  });
});

describe('7-P2-3 the timeline says the open question was closed', () => {
  it('7-P2-3 an info_request_closed event reads as a closed question, not "Updated"', async () => {
    const req = approvalRequest({
      id: 'req-9', entityType: 'LEAVE', employeeName: 'Priya Sharma', currentStep: 2, stepCount: 2, context: leaveContext(),
      events: [
        { id: 'e1', at: '2026-09-21T08:00:00Z', actorUserId: 'u5', actorName: 'Team Approver', kind: 'info_requested', detail: { stepNo: 1, comment: 'Who covers?' } },
        { id: 'e2', at: '2026-09-21T09:00:00Z', actorUserId: 'u5', actorName: 'Team Approver', kind: 'step_approved', detail: { stepNo: 1 } },
        { id: 'e3', at: '2026-09-21T09:00:00Z', actorUserId: 'u5', actorName: 'Team Approver', kind: 'info_request_closed', detail: { fromStepNo: 1, stepNo: 2, reason: 'level approved' } },
      ],
    });
    mockGet({ '/orgs/org-1/approvals/req-9': { data: req } });
    renderWithProviders(<RequestDetail requestId="req-9" />);
    expect(await screen.findByText('Open question closed — its level was approved')).toBeInTheDocument();
    expect(screen.queryByText('Updated')).not.toBeInTheDocument();
  });
});
