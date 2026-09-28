import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { SelfLeaveDto, SelfOverviewDto } from '@flowza/contracts';
import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { Sidebar } from '@/components/layout/sidebar';
import { RequirePermission } from '@/components/layout/protected-route';
import './routes';
import '@/features/approvals/routes';
import { approvalRequest, approvalStep, leaveContext } from '@/features/approvals/test-fixtures';
import { ApplyLeaveDialog } from './components/apply-leave-dialog';
import MyLeavePage from './pages/leave-page';
import PortalHomePage from './pages/home-page';

const EMP = '11111111-1111-4111-8111-111111111111';
const AL = '22222222-2222-4222-8222-222222222222';
const SL = '33333333-3333-4333-8333-333333333333';

const leaveRecord = (over: Partial<SelfLeaveDto['records'][number]> = {}): SelfLeaveDto['records'][number] => ({
  id: 'l1', leaveTypeId: AL, leaveTypeCode: 'AL', leaveTypeName: 'Annual Leave', color: '#175cd3', isPaid: true, startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false, halfDayPart: null, days: 5,
  reason: 'Family visit', status: 'PENDING', decisionNote: null, approvedByName: null, approvedAt: null, createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T06:00:00Z',
  approvalRequestId: null, approvalStatus: null, approvalCurrentStep: null, approvalStepCount: null, ...over,
});
const leaveData = (records = [leaveRecord()]): SelfLeaveDto => ({
  year: 2026,
  types: [{ id: AL, code: 'AL', name: 'Annual Leave', nameAr: null, isPaid: true, color: '#175cd3', annualAllowanceDays: 30 }, { id: SL, code: 'SL', name: 'Sick Leave', nameAr: null, isPaid: true, color: '#b54708', annualAllowanceDays: null }],
  balances: [{ leaveTypeId: AL, allowanceDays: 30, usedDays: 22, pendingDays: 5, remainingDays: 3 }, { leaveTypeId: SL, allowanceDays: null, usedDays: 2, pendingDays: 0, remainingDays: null }],
  records,
  calendar: { weeklyOffDays: [5, 6], holidays: ['2026-10-07'] },
});

beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.employeeId = EMP; });

describe('portal navigation', () => {
  it('shows "My workspace" only to members linked to an employee record', () => {
    renderWithProviders(<Sidebar />);
    for (const name of ['My overview', 'My attendance', 'My leave', 'My profile']) expect(screen.getByRole('link', { name })).toBeInTheDocument();
    testState.employeeId = null;
    renderWithProviders(<Sidebar />);
    expect(screen.getAllByRole('link', { name: 'My leave' })).toHaveLength(1); // only the first render's
  });

  it('sends an employee without the HR permission to the self-service page instead of "permission denied"', () => {
    grant('attendance.view_own');
    renderWithProviders(<RequirePermission permissions={['attendance.view']} selfServiceTo="/my/attendance"><p>HR page</p></RequirePermission>, { route: '/attendance' });
    expect(screen.getByTestId('location')).toHaveTextContent('/my/attendance');
    expect(screen.queryByText('HR page')).not.toBeInTheDocument();
  });
});

describe('ApplyLeaveDialog', () => {
  it('previews the working days, warns past the balance and posts a PENDING request', async () => {
    apiMock.post.mockResolvedValue({ data: leaveRecord({ id: 'new' }) });
    const onOpenChange = vi.fn();
    renderWithProviders(<ApplyLeaveDialog open onOpenChange={onOpenChange} data={leaveData([])} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Leave type/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Annual Leave/ }));
    // Sun 4 → Thu 8 Oct 2026 with Wed 7 a holiday: 4 working days, one more than the 3 left
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: '2026-10-04' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-10-08' } });
    const preview = screen.getByTestId('leave-preview');
    expect(preview).toHaveTextContent('This request uses 4 working days.');
    expect(preview).toHaveTextContent('more than your remaining Annual Leave balance (3 days)');
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Family visit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/me/leave', { leaveTypeId: AL, startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false, reason: 'Family visit' }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('requires a reason and refuses a range with no working day', async () => {
    renderWithProviders(<ApplyLeaveDialog open onOpenChange={vi.fn()} data={leaveData([])} />);
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: '2026-10-09' } }); // Friday
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-10-10' } }); // Saturday
    expect(screen.getByTestId('leave-preview')).toHaveTextContent('Every date in this range is a weekly off day or a holiday.');
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();
  });
});

describe('MyLeavePage', () => {
  it('lists requests with HR\'s decision and withdraws a pending one', async () => {
    const approved = leaveRecord({ id: 'l0', status: 'APPROVED', startDate: '2026-08-23', endDate: '2026-08-27', decisionNote: 'Enjoy Onam!', approvedByName: 'Fatma Al Balushi' });
    mockGet({ '/orgs/org-1/me/leave': { data: leaveData([leaveRecord(), approved]) } });
    apiMock.post.mockResolvedValue({ data: leaveRecord({ status: 'CANCELLED' }) });
    renderWithProviders(<MyLeavePage />);
    expect((await screen.findAllByText('Enjoy Onam!')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('by Fatma Al Balushi').length).toBeGreaterThan(0);
    expect(screen.getByText('3 of 30 days left')).toBeInTheDocument();
    expect(screen.getByText('2 days taken')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Withdraw/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    // leave v2 (B-98): a withdrawal carries a reason for the approvers — the button waits for one
    const confirm = within(dialog).getByRole('button', { name: /Withdraw/ });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Why are you withdrawing it/), { target: { value: 'Plans changed' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/me/leave/l1/withdraw', { reason: 'Plans changed' }));
  });
});

describe('MyLeavePage — approval engine', () => {
  it('shows the level a request waits at and opens its timeline', async () => {
    const pendingTwoLevels = leaveRecord({ approvalRequestId: 'req-9', approvalStatus: 'PENDING', approvalCurrentStep: 2, approvalStepCount: 2 });
    const req = approvalRequest({
      id: 'req-9', entityType: 'LEAVE', employeeName: 'Priya Sharma', requestedBy: 'u1', requestedByName: 'Priya Sharma', subjectUserId: 'u1', currentStep: 2, stepCount: 2, context: leaveContext(),
      steps: [approvalStep({ requestId: 'req-9', status: 'APPROVED', actors: [{ userId: 'u5', userName: 'Mansoor', viaDelegationOf: null, viaDelegationOfName: null, resolutionPath: 'primary', decision: 'APPROVED', decidedAt: '2026-09-21T06:00:00Z', comment: 'Fine' }] }), approvalStep({ id: 'step-2', requestId: 'req-9', stepNo: 2, approverType: 'HR_ADMIN', resolutionPath: 'hr_admin', actors: [{ userId: 'u6', userName: 'Fatma', viaDelegationOf: null, viaDelegationOfName: null, resolutionPath: 'hr_admin', decision: 'PENDING', decidedAt: null, comment: null }] })],
      abilities: { canDecide: false, canCancel: true, canReassign: false, canBypass: false, canRequestInfo: false, canAnswerInfo: false, actingAsDelegateOf: null },
      events: [{ id: '1', at: '2026-09-20T06:00:00Z', actorUserId: 'u1', actorName: 'Priya Sharma', kind: 'submitted', detail: {} }, { id: '2', at: '2026-09-21T06:00:00Z', actorUserId: 'u5', actorName: 'Mansoor', kind: 'step_approved', detail: { stepNo: 1, comment: 'Fine' } }],
    });
    mockGet({ '/orgs/org-1/me/leave': { data: leaveData([pendingTwoLevels]) }, '/orgs/org-1/approvals/req-9': { data: req } });
    renderWithProviders(<MyLeavePage />);
    expect((await screen.findAllByText('Level 2 of 2')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: /Timeline/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Level 1 approved')).toBeInTheDocument();
    expect(within(dialog).getByText('Fatma')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Withdraw/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });
});

describe('PortalHomePage', () => {
  it('greets the employee and shows today, balances and holidays', async () => {
    const overview: SelfOverviewDto = {
      date: '2026-09-27', timezone: 'Asia/Muscat',
      today: { id: 'r1', employeeId: EMP, employeeNumber: 'MG-1012', employeeName: 'Priya Sharma', attendanceDate: '2026-09-27', branchId: 'b1', branchName: 'Head Office', departmentId: null, departmentName: null, shiftId: 's1', shiftName: 'Office 08:00–17:00', timezone: 'Asia/Muscat', expectedStartAt: '2026-09-27T04:00:00Z', expectedEndAt: '2026-09-27T13:00:00Z', scheduledMinutes: 480, firstInAt: '2026-09-27T04:07:00Z', lastOutAt: null, workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null, status: 'PENDING', flags: [], punchCount: 1, hasCorrection: false, calculationVersion: 1, computedAt: '2026-09-27T04:10:00Z', lockedAt: null, lopDays: 0, unexcused: false },
      month: { month: '2026-09', totals: { present: 17, absent: 0, leave: 0, holiday: 0, weeklyOff: 8, halfDay: 0, late: 2, missingPunch: 1, workedMinutes: 8400, overtimeMinutes: 95, lateMinutes: 23, earlyDepartureMinutes: 0, workingDays: 18, attendanceRate: 1 } },
      recent: [], balances: [{ leaveTypeId: AL, allowanceDays: 30, usedDays: 7, pendingDays: 5, remainingDays: 18, name: 'Annual Leave', code: 'AL', color: '#175cd3' }],
      upcomingLeave: [leaveRecord()], pendingLeave: 1, pendingCorrections: 1,
      upcomingHolidays: [{ date: '2026-11-18', endDate: '2026-11-19', name: 'National Day', nameAr: null }],
    };
    mockGet({ '/orgs/org-1/me/overview': { data: overview }, '/orgs/org-1/me/profile': { data: { displayName: 'Priya Sharma', designation: { id: 'd', name: 'Software Engineer' }, department: { id: 'x', name: 'Information Technology' }, branch: { id: 'b1', name: 'Head Office', timezone: 'Asia/Muscat' } } }, '/orgs/org-1/me/leave': { data: leaveData() } });
    renderWithProviders(<PortalHomePage />);
    expect(await screen.findByRole('heading', { level: 1, name: /Priya/ })).toBeInTheDocument();
    expect(await screen.findByText('Software Engineer · Information Technology · Head Office')).toBeInTheDocument();
    expect(screen.getByText('Office 08:00–17:00')).toBeInTheDocument();
    expect(screen.getByText('08:07')).toBeInTheDocument(); // first in, Muscat time
    expect(screen.getByText('18 of 30 days left')).toBeInTheDocument();
    expect(screen.getByText('National Day')).toBeInTheDocument();
    expect(screen.getByText('1 leave request awaiting HR')).toBeInTheDocument();
    expect(screen.getByText('1 correction awaiting approval')).toBeInTheDocument();
  });
});
