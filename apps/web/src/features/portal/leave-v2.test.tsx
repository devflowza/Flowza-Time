import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { SelfCompOffDto, SelfLeaveDto } from '@flowza/contracts';
import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { todayIso } from '@/lib/format';
import './routes';
import '@/features/approvals/routes';
import { ApplyLeaveDialog } from './components/apply-leave-dialog';
import MyLeavePage from './pages/leave-page';
import { TeamUpcomingLeave } from '@/features/leave/components/team-upcoming-leave';

/**
 * Leave v2 in the portal: the five totals and a card per type, the approver's question answered from the page, edit (only
 * what changed, resent to the approvers), the apply dialog's count per count mode and the rules the API refuses, comp-off
 * (request with the day's preview, use the credits) and the team's upcoming leave for managers.
 */
const EMP = '11111111-1111-4111-8111-111111111111';
const AL = '22222222-2222-4222-8222-222222222222';
const CA = '33333333-3333-4333-8333-333333333333';
const NT = '55555555-5555-4555-8555-555555555555';
const CO = '66666666-6666-4666-8666-666666666666';

/** Dates relative to today in the organisation's timezone (what the dialog compares with). */
const plusDays = (n: number) => { const d = new Date(`${todayIso('Asia/Muscat')}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

type Rec = SelfLeaveDto['records'][number];
const rec = (over: Partial<Rec> = {}): Rec => ({
  id: 'l2', leaveTypeId: AL, leaveTypeCode: 'AL', leaveTypeName: 'Annual Leave', color: '#175cd3', isPaid: true, startDate: '2026-11-01', endDate: '2026-11-02', isHalfDay: false, halfDayPart: null, days: 2,
  reason: 'Family visit', status: 'PENDING', decisionNote: null, approvedByName: null, approvedAt: null, createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T06:00:00Z',
  approvalRequestId: 'req-2', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1, canEdit: true, canWithdraw: true, canReply: false, commentCount: 0, infoRequest: null, compOff: false, ...over,
});
const data = (records: Rec[] = []): SelfLeaveDto => ({
  year: 2026,
  types: [
    { id: AL, code: 'AL', name: 'Annual Leave', nameAr: null, isPaid: true, color: '#175cd3', annualAllowanceDays: 30, countMode: 'working', allowHalfDay: true, advanceNoticeDays: 0, maxConsecutiveDays: null, requiresApproval: true, accrual: 'none', compOff: false },
    { id: CA, code: 'CA', name: 'Calendar Leave', nameAr: null, isPaid: true, color: '#0e7490', annualAllowanceDays: 10, countMode: 'calendar', allowHalfDay: false, advanceNoticeDays: 0, maxConsecutiveDays: null, requiresApproval: true, accrual: 'none', compOff: false },
    { id: NT, code: 'NT', name: 'Notice Leave', nameAr: null, isPaid: true, color: '#b54708', annualAllowanceDays: null, countMode: 'working', allowHalfDay: true, advanceNoticeDays: 7, maxConsecutiveDays: 3, requiresApproval: true, accrual: 'none', compOff: false },
  ],
  balances: [
    { leaveTypeId: AL, allowanceDays: 34, usedDays: 10, pendingDays: 4, remainingDays: 20, tracked: true, availableDays: 24, availableAfterPendingDays: 20, carriedForwardDays: 4, carriedForwardExpiresOn: '2026-03-31', carriedForwardExpiredDays: 0, accrual: 'none' },
    { leaveTypeId: CA, allowanceDays: 10, usedDays: 0, pendingDays: 0, remainingDays: 10, tracked: true, availableDays: 10, availableAfterPendingDays: 10, carriedForwardDays: 0, carriedForwardExpiresOn: null, carriedForwardExpiredDays: 0, accrual: 'monthly', accruedToDateDays: 7.5 },
    { leaveTypeId: NT, allowanceDays: null, usedDays: 1, pendingDays: 0, remainingDays: null, tracked: false },
  ],
  records,
  calendar: { weeklyOffDays: [5, 6], holidays: [] },
  asOf: '2026-09-28',
  totals: { entitlementDays: 44, takenDays: 10, pendingDays: 4, availableDays: 34, accruedToDateDays: 41.5 },
  compOff: { leaveTypeId: CO, earnedDays: 2, usedDays: 0, availableDays: 2, pendingDays: 0, availableAfterPendingDays: 2 },
});
const compOff: SelfCompOffDto = {
  balance: { leaveTypeId: CO, earnedDays: 2, usedDays: 0, availableDays: 2, pendingDays: 0, availableAfterPendingDays: 2 },
  credits: [{ id: 'c1', employeeId: EMP, workedOn: '2026-09-04', workedOnType: 'weekly_off', workedMinutes: 480, daysEarned: 1, location: 'HQ', summary: 'Cut-over', status: 'approved', usedDays: 0, remainingDays: 1, expiresOn: '2026-12-03', decisionNote: null, approvalRequestId: 'req-c1', approvalStatus: 'APPROVED', createdAt: '2026-09-05T06:00:00Z', updatedAt: '2026-09-05T06:00:00Z' }],
  rules: { fullDayHours: 8, halfDayHours: 4, expiryDays: 90 },
};

beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.employeeId = EMP; testState.teamSize = 0; });

function mockPortal(records: Rec[]) {
  mockGet({
    '/orgs/org-1/me/leave': { data: data(records) },
    '/orgs/org-1/me/comp-off': { data: compOff },
    '/orgs/org-1/me/comp-off/preview': (q: Record<string, unknown> | undefined) => ({ data: { workedOn: q?.['workedOn'], workedOnType: 'weekly_off', holidayName: null, recordedMinutes: 480, daysEarned: 1, alreadyRequested: false, eligible: true, reason: null } }),
    '/orgs/org-1/leave-records/l1/comments': { data: [{ id: 'm1', leaveRecordId: 'l1', authorUserId: 'u5', authorName: 'Mansoor', kind: 'info_request', body: 'Who covers your shift?', createdAt: '2026-09-21T06:00:00Z', mine: false }] },
  });
}

describe('/my/leave v2', () => {
  it('shows the five totals, a card per type (carry-forward and accrual) and the open question', async () => {
    mockPortal([rec({ id: 'l1', status: 'INFO_REQUESTED', canReply: true, commentCount: 1, infoRequest: { message: 'Who covers your shift?', askedAt: '2026-09-21T06:00:00Z', askedByName: 'Mansoor' } })]);
    renderWithProviders(<MyLeavePage />);
    expect(await screen.findAllByTestId('leave-type-card')).toHaveLength(3);
    const tiles = screen.getByRole('region', { name: 'Leave totals' });
    for (const [label, value] of [['Entitlement', '44'], ['Used', '10'], ['Pending', '4'], ['Available', '34'], ['Accrued to date', '41.5']] as const) {
      expect(within(tiles).getByText(label).parentElement).toHaveTextContent(value);
    }
    expect(screen.getByText('Includes 4 days carried forward, usable until 31 Mar 2026')).toBeInTheDocument();
    expect(screen.getByText('20 of 34 days left')).toBeInTheDocument();
    expect(screen.getByText('7.5')).toBeInTheDocument(); // accrued to date of the monthly type
    const banner = screen.getAllByRole('status').find((el) => el.textContent?.includes('An approver asked you a question'))!;
    expect(banner).toHaveTextContent('Who covers your shift?');
    const badge = screen.getAllByText('Info requested')[0]!.closest('[data-status]')!;
    expect(badge.className).toContain('indigo');
  });

  it('answers the approver\'s question: the reply goes through the engine and the request goes back to PENDING', async () => {
    mockPortal([rec({ id: 'l1', status: 'INFO_REQUESTED', canReply: true, commentCount: 1, infoRequest: { message: 'Who covers your shift?', askedAt: '2026-09-21T06:00:00Z', askedByName: 'Mansoor' } })]);
    apiMock.post.mockResolvedValue({ data: rec({ id: 'l1', status: 'PENDING' }) });
    renderWithProviders(<MyLeavePage />);
    await screen.findAllByText('Who covers your shift?');
    const banner = screen.getAllByRole('status').find((el) => el.textContent?.includes('An approver asked you a question'))!;
    fireEvent.click(within(banner).getByRole('button', { name: /Reply/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Mansoor asked:')).toBeInTheDocument();
    expect((await within(dialog).findAllByText('Who covers your shift?')).length).toBeGreaterThan(0);
    fireEvent.change(within(dialog).getByLabelText('Your answer to the approver'), { target: { value: 'Salim covers it' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Send answer/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/me/leave/l1/reply', { body: 'Salim covers it' }));
  });

  it('edits a pending request: only what changed is sent, and it is resent to the approvers', async () => {
    mockPortal([rec()]);
    apiMock.patch.mockResolvedValue({ data: rec({ endDate: '2026-11-03', days: 3 }) });
    renderWithProviders(<MyLeavePage />);
    const row = await screen.findByTestId('leave-row-l2');
    fireEvent.click(within(row).getByRole('button', { name: /Edit/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit leave request')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^To/)).toHaveValue('2026-11-02');
    fireEvent.change(within(dialog).getByLabelText(/^To/), { target: { value: '2026-11-03' } });
    // Sun 1 → Tue 3 November: 3 working days; own 2 pending days are given back to the balance before this one counts
    expect(within(dialog).getByTestId('leave-preview')).toHaveTextContent('This request uses 3 working days.');
    expect(within(dialog).getByTestId('leave-preview')).toHaveTextContent('19 days of Annual Leave left after this request.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and resend' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/me/leave/l2', { endDate: '2026-11-03' }));
  });

  it('offers edit and withdraw only where the API allows them', async () => {
    mockPortal([rec({ id: 'l3', status: 'APPROVED', canEdit: false, canWithdraw: false })]);
    renderWithProviders(<MyLeavePage />);
    const row = await screen.findByTestId('leave-row-l3');
    expect(within(row).queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Withdraw/ })).not.toBeInTheDocument();
  });
});

describe('ApplyLeaveDialog v2', () => {
  const pick = async (name: RegExp) => {
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Leave type/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name }));
  };

  it('counts every calendar day for a calendar-mode type', async () => {
    renderWithProviders(<ApplyLeaveDialog open onOpenChange={vi.fn()} data={data()} />);
    await pick(/Calendar Leave/);
    // Thu 8 → Sat 10 October 2026: 3 calendar days (Friday and Saturday count too)
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: '2026-10-08' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-10-10' } });
    expect(screen.getByTestId('leave-preview')).toHaveTextContent('This request uses 3 calendar days.');
    expect(screen.getByTestId('leave-preview')).toHaveTextContent('7 days of Calendar Leave left after this request.');
    // this type allows no half days: the switch is replaced by a note
    expect(screen.queryByRole('switch', { name: /Half day/ })).not.toBeInTheDocument();
  });

  it('refuses short notice and more days than the type allows before sending', async () => {
    renderWithProviders(<ApplyLeaveDialog open onOpenChange={vi.fn()} data={data()} />);
    await pick(/Notice Leave/);
    // a working day (not Friday / Saturday) less than 7 days ahead
    const start = [1, 2, 3].map(plusDays).find((d) => ![5, 6].includes(weekday(d)))!;
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: start } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: start } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Short notice' } });
    const preview = screen.getByTestId('leave-preview');
    expect(preview.querySelector('[data-issue="ADVANCE_NOTICE"]')).toHaveTextContent(`Notice Leave needs 7 days' notice — the earliest start date is ${plusDays(7)}.`);
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();
    // four working days on a type that allows three per request
    const far = plusDays(21);
    const sunday = plusDays(21 + ((7 - weekday(far)) % 7));
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: sunday } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: plusDays(21 + ((7 - weekday(far)) % 7) + 3) } });
    expect(screen.getByTestId('leave-preview').querySelector('[data-issue="MAX_CONSECUTIVE"]')).toHaveTextContent('Notice Leave allows at most 3 days per request.');
    expect(screen.getByTestId('leave-preview').querySelector('[data-issue="ADVANCE_NOTICE"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();
  });
});

describe('ApplyLeaveDialog — one leave per date (B-47)', () => {
  it('refuses a range that shares a date with the employee\'s own pending leave, before sending', async () => {
    renderWithProviders(<ApplyLeaveDialog open onOpenChange={vi.fn()} data={data([rec({ startDate: '2026-11-01', endDate: '2026-11-02' })])} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Leave type/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Annual Leave/ }));
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: '2026-11-02' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-11-03' } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Another trip' } });
    expect(screen.getByTestId('leave-preview').querySelector('[data-issue="OVERLAP"]')).toHaveTextContent('You already have Annual Leave from 2026-11-01 to 2026-11-02 (Pending)');
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: '2026-11-03' } });
    expect(screen.getByTestId('leave-preview').querySelector('[data-issue="OVERLAP"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled();
  });
});

describe('comp-off in the portal', () => {
  it('requests a credit with the day\'s preview (claimed hours from the attendance record)', async () => {
    mockPortal([]);
    apiMock.post.mockResolvedValue({ data: compOff.credits[0] });
    renderWithProviders(<MyLeavePage />);
    expect(await screen.findByTestId('comp-off-available')).toHaveTextContent('2');
    expect(screen.getByText(/expires 03 Dec 2026/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Request comp-off/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Day worked/), { target: { value: '2026-09-18' } });
    expect(await within(dialog).findByTestId('comp-off-preview')).toHaveTextContent('Your weekly off day.');
    expect(within(dialog).getByTestId('comp-off-preview')).toHaveTextContent('Earns 1 day of comp-off once approved.');
    await waitFor(() => expect(within(dialog).getByLabelText(/Hours worked/)).toHaveValue(8));
    fireEvent.change(within(dialog).getByLabelText(/Where did you work/), { target: { value: 'Sohar plant' } });
    fireEvent.change(within(dialog).getByLabelText(/What did you work on/), { target: { value: 'Shutdown maintenance' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/me/comp-off', { workedOn: '2026-09-18', workedOnType: 'weekly_off', workedMinutes: 480, location: 'Sohar plant', summary: 'Shutdown maintenance' }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
  });

  it('uses the credits: a leave of the comp-off type', async () => {
    mockPortal([]);
    apiMock.post.mockResolvedValue({ data: rec({ id: 'new', leaveTypeId: CO, compOff: true }) });
    renderWithProviders(<MyLeavePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Use comp-off/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2 days available/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/From/), { target: { value: '2026-11-01' } });
    fireEvent.change(within(dialog).getByLabelText(/^To/), { target: { value: '2026-11-01' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Rest after the shutdown' } });
    expect(within(dialog).getByTestId('leave-preview')).toHaveTextContent('1 comp-off days left after this request.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/me/leave', { leaveTypeId: CO, startDate: '2026-11-01', endDate: '2026-11-01', isHalfDay: false, reason: 'Rest after the shutdown' }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
  });
});

describe('team upcoming leave (/my, managers)', () => {
  const team = [{ id: 't1', employeeId: 'e7', employeeName: 'Salim Al Harthy', employeeNumber: 'MG-1007', leaveTypeId: AL, leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', color: '#175cd3', startDate: '2026-10-11', endDate: '2026-10-12', isHalfDay: false, halfDayPart: null, days: 2, status: 'PENDING' }];

  it('shows the team\'s approved and pending leave to a manager with leave.view_team', async () => {
    testState.teamSize = 3; grant('leave.view_team', 'leave.request');
    mockGet({ '/orgs/org-1/me/team/leave': { data: team } });
    renderWithProviders(<TeamUpcomingLeave />);
    expect(await screen.findByText('Salim Al Harthy')).toBeInTheDocument();
    expect(screen.getByText('Team leave')).toBeInTheDocument();
    expect(screen.getByText(/2 days/)).toBeInTheDocument();
  });

  it('stays hidden (and silent) without direct reports or without leave.view_team', () => {
    testState.teamSize = 0; grantAll();
    renderWithProviders(<TeamUpcomingLeave />);
    expect(screen.queryByText('Team leave')).not.toBeInTheDocument();
    testState.teamSize = 3; grant('leave.request');
    renderWithProviders(<TeamUpcomingLeave />);
    expect(screen.queryByText('Team leave')).not.toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});
