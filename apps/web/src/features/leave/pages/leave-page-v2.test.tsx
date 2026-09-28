import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() }, toastError: vi.fn(), toastQueued: vi.fn() }));

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { toast } from '@/lib/toast';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/leave.json';
import ar from '@/locales/ar/leave.json';
import '@/features/approvals/routes';
import { approvalRequest, approvalStep, leaveContext } from '@/features/approvals/test-fixtures';
import LeavePage from './leave-page';

registerNamespace('leave', en, ar);

/**
 * Leave v2 on the HR Leave page: the decision names the level the user saw (P1-2) and the toast tells what happened (P2-9);
 * the info-requested badge; Balances (+ CSV behind report.export), Allocations (edit, year close), the team calendar and the
 * system-managed comp-off type.
 */
const AL = '22222222-2222-4222-8222-222222222222';
const CO = '33333333-3333-4333-8333-333333333333';
const EMP = '44444444-4444-4444-8444-444444444444';
const DEP = '55555555-5555-4555-8555-555555555555';
const types = [
  { id: AL, code: 'AL', name: 'Annual Leave', nameAr: null, isPaid: true, treatAsPresent: false, color: '#175cd3', annualAllowanceDays: 30, status: 'active', createdAt: '', requiresApproval: true, countMode: 'working', advanceNoticeDays: 7, maxConsecutiveDays: 10, carryForwardMaxDays: 5, applicableGender: 'all', accrual: 'none', portalVisible: true, isSpecial: false, compOff: false },
  { id: CO, code: 'CO', name: 'Comp off', nameAr: null, isPaid: true, treatAsPresent: false, color: '#6941c6', annualAllowanceDays: null, status: 'active', createdAt: '', requiresApproval: true, countMode: 'working', portalVisible: false, isSpecial: true, compOff: true, systemKey: 'COMP_OFF' },
];
const record = (over: Record<string, unknown> = {}) => ({
  id: 'l1', employeeId: EMP, employeeNumber: 'MG-1012', employeeName: 'Priya Sharma', leaveTypeId: AL, leaveTypeName: 'Annual Leave', branchId: null, startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false, halfDayPart: null,
  reason: 'Diwali in Kerala', status: 'PENDING', source: 'SELF_SERVICE', decisionNote: null, approvedBy: null, approvedAt: null, createdBy: 'u9', createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T06:00:00Z',
  days: 4, withdrawnAt: null, editedAt: null, approvalRequestId: 'req-1', approvalStatus: 'PENDING', approvalCurrentStep: 2, approvalStepCount: 3, approvalWaitingFor: ['Mansoor Al Habsi'], commentCount: 2, ...over,
});
const balance = (over: Record<string, unknown> = {}) => ({ leaveTypeId: AL, code: 'AL', name: 'Annual Leave', nameAr: null, color: '#175cd3', isPaid: true, countMode: 'working', accrual: 'none', compOff: false, tracked: true, hasAllocation: true, allocatedDays: 30, carriedForwardDays: 4, carriedForwardExpiresOn: '2026-03-31', carriedForwardExpiredDays: 0, openingBalanceDays: 0, adjustmentDays: 0, entitlementDays: 34, takenDays: 10, pendingDays: 4, accruedToDateDays: 34, availableDays: 24, availableAfterPendingDays: 20, ...over });

beforeEach(() => {
  resetApiMock(); grantAll();
  vi.mocked(toast.success).mockReset(); vi.mocked(toast.error).mockReset();
  mockGet({
    '/orgs/org-1/leave-records': page([record(), record({ id: 'l2', status: 'INFO_REQUESTED', employeeName: 'Salim Al Harthy', approvalCurrentStep: 1, approvalWaitingFor: [] })]),
    '/orgs/org-1/leave-types': { data: types },
    '/orgs/org-1/employees': page([]),
    '/orgs/org-1/branches': page([]),
    '/orgs/org-1/departments': page([{ id: DEP, name: 'Finance', code: 'FIN', branchId: null, branchName: null, status: 'active' }]),
    '/orgs/org-1/leave-balances': page([{ employeeId: EMP, employeeNumber: 'MG-1012', employeeName: 'Priya Sharma', branchId: null, departmentId: null, joiningDate: '2024-01-01', year: 2026, asOf: '2026-09-28', balances: [balance(), balance({ leaveTypeId: CO, code: 'CO', name: 'Comp off', compOff: true, tracked: true, entitlementDays: 1, takenDays: 0, pendingDays: 0, availableDays: 1, availableAfterPendingDays: 1, carriedForwardDays: 0, carriedForwardExpiresOn: null })] }]),
    '/orgs/org-1/leave-allocations': page([{ id: 'a1', employeeId: EMP, employeeNumber: 'MG-1012', employeeName: 'Priya Sharma', branchId: null, leaveTypeId: AL, leaveTypeCode: 'AL', leaveTypeName: 'Annual Leave', year: 2026, allocatedDays: 30, carriedForwardDays: 4, carriedForwardExpiresOn: '2026-03-31', openingBalanceDays: 0, adjustmentDays: 0, notes: null, updatedAt: '2026-01-01T00:00:00Z', updatedBy: null }]),
    '/orgs/org-1/leave-calendar': { data: { month: '2026-10', from: '2026-10-01', to: '2026-10-31', truncated: false, employees: [{ employeeId: EMP, employeeName: 'Priya Sharma', employeeNumber: 'MG-1012', branchId: null, departmentId: null }], entries: [{ id: 'l1', employeeId: EMP, employeeName: 'Priya Sharma', employeeNumber: 'MG-1012', leaveTypeId: AL, leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', color: '#175cd3', startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false, halfDayPart: null, days: 4, status: 'APPROVED' }] } },
  });
});

describe('Requests — decisions through the engine', () => {
  it('P1-2: a decision sends the level the user saw (stepNo); P2-9: the toast says only the level moved', async () => {
    apiMock.patch.mockResolvedValue({ data: { ...record(), approvalCurrentStep: 3, approvalWaitingFor: ['Fatma Al Balushi'], recalculationJobId: null } });
    renderWithProviders(<LeavePage />, { route: '/leave' });
    expect(await screen.findByText('Level 2 of 3')).toBeInTheDocument();
    expect(screen.getByText('Waiting for Mansoor Al Habsi')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Approve/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('decision-level')).toHaveTextContent('Your decision settles level 2 of 3.');
    fireEvent.click(within(dialog).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/leave-records/l1', { status: 'APPROVED', decisionNote: null, stepNo: 2 }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Level 2 approved — waiting for Fatma Al Balushi'));
  });

  it('P2-9: "Leave approved" only when the leave itself is approved', async () => {
    apiMock.patch.mockResolvedValue({ data: { ...record(), status: 'APPROVED', approvalStatus: 'APPROVED', approvalWaitingFor: [], recalculationJobId: null } });
    renderWithProviders(<LeavePage />, { route: '/leave' });
    fireEvent.click((await screen.findAllByRole('button', { name: /^Approve/ }))[0]!);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Leave approved'));
  });

  it('shows "info requested" in indigo and still lets HR decide it', async () => {
    renderWithProviders(<LeavePage />, { route: '/leave' });
    const badge = (await screen.findAllByText('Info requested')).find((el) => el.closest('[data-status]'))!.closest('[data-status]')!;
    expect(badge).toHaveAttribute('data-status', 'INFO_REQUESTED');
    expect(badge.className).toContain('indigo');
    expect(screen.getAllByRole('button', { name: /^Reject/ })).toHaveLength(2);
  });
});

describe('Requests — the detail: conversation and the engine', () => {
  it('opens a request with its thread and the approval levels; HR comments reach the thread', async () => {
    const req = approvalRequest({ id: 'req-1', entityType: 'LEAVE', employeeName: 'Priya Sharma', currentStep: 2, stepCount: 3, context: leaveContext(), steps: [approvalStep({ requestId: 'req-1', status: 'APPROVED' }), approvalStep({ id: 'step-2', requestId: 'req-1', stepNo: 2 })] });
    mockGet({
      '/orgs/org-1/leave-records': page([record()]),
      '/orgs/org-1/leave-types': { data: types },
      '/orgs/org-1/employees': page([]),
      '/orgs/org-1/branches': page([]),
      '/orgs/org-1/approvals/req-1': { data: req },
      '/orgs/org-1/leave-records/l1/comments': { data: [{ id: 'm1', leaveRecordId: 'l1', authorUserId: 'u5', authorName: 'Mansoor Al Habsi', kind: 'info_request', body: 'Who covers the release?', createdAt: '2026-09-21T06:00:00Z', mine: false }, { id: 'm2', leaveRecordId: 'l1', authorUserId: 'u9', authorName: 'Priya Sharma', kind: 'reply', body: 'Salim does.', createdAt: '2026-09-21T07:00:00Z', mine: false }] },
    });
    apiMock.post.mockResolvedValue({ data: { id: 'm3', leaveRecordId: 'l1', authorUserId: 'u1', authorName: 'Dev', kind: 'comment', body: 'Thanks, noted.', createdAt: '2026-09-22T06:00:00Z', mine: true } });
    renderWithProviders(<LeavePage />, { route: '/leave' });
    fireEvent.click((await screen.findAllByText('Diwali in Kerala'))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Who covers the release?')).toBeInTheDocument();
    expect(within(dialog).getByText('Salim does.').closest('[data-kind]')).toHaveAttribute('data-kind', 'reply');
    expect(await within(dialog).findByText('Levels')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Add a comment'), { target: { value: 'Thanks, noted.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/leave-records/l1/comments', { body: 'Thanks, noted.' }));
  });
});

describe('Balances, allocations, calendar, types', () => {
  it('lists balances per type and offers the CSV to report.export holders only', async () => {
    const fetchMock = vi.fn(async () => new Response('csv', { status: 200, headers: { 'content-disposition': 'attachment; filename="leave-balances-2026.csv"' } }));
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderWithProviders(<LeavePage />, { route: '/leave?tab=balances' });
    expect((await screen.findAllByText('24')).length).toBeGreaterThan(0); // AL available
    expect(screen.getAllByText('4 pending').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/incl\. 4 carried, expires 2026-03-31/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/orgs/org-1/leave-balances/export?year='), expect.objectContaining({ headers: { Authorization: 'Bearer token' } })));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    download.mockRestore();
    vi.unstubAllGlobals();
  });

  it('hides the CSV without report.export', async () => {
    grant('leave.view', 'leave.manage');
    renderWithProviders(<LeavePage />, { route: '/leave?tab=balances' });
    expect((await screen.findAllByText('24')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument();
  });

  it('edits an allocation row (PUT, full row) and queues the year close', async () => {
    apiMock.put.mockResolvedValue({ data: { created: 0, updated: 1, unchanged: 0, allocations: [] } });
    apiMock.post.mockResolvedValue({ data: { jobId: 'job-7', status: 'QUEUED', fromYear: 2025, toYear: 2026 } });
    renderWithProviders(<LeavePage />, { route: '/leave?tab=allocations&year=2026' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Adjustment/), { target: { value: '1.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/leave-allocations', { rows: [expect.objectContaining({ employeeId: EMP, leaveTypeId: AL, year: 2026, allocatedDays: 30, carriedForwardDays: 4, carriedForwardExpiresOn: '2026-03-31', adjustmentDays: 1.5 })] }));
    fireEvent.click(screen.getByRole('button', { name: /Close 2025 → 2026/ }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /Close 2025 → 2026/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/leave-allocations/year-close', { fromYear: 2025 }));
  });

  it('draws the team calendar from the API', async () => {
    renderWithProviders(<LeavePage />, { route: '/leave?tab=calendar' });
    expect(await screen.findByRole('rowheader', { name: /Priya Sharma/ })).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/leave-calendar', expect.objectContaining({ includePending: true }));
  });

  it('filters the team calendar by department', async () => {
    renderWithProviders(<LeavePage />, { route: '/leave?tab=calendar' });
    await screen.findByRole('rowheader', { name: /Priya Sharma/ });
    // the combobox trigger shows its placeholder (a combobox takes no name from its content)
    fireEvent.click(screen.getByText('Department').closest('[role="combobox"]')!);
    fireEvent.click(await screen.findByText('Finance'));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/leave-calendar', expect.objectContaining({ departmentId: DEP })));
  });

  it('keeps the comp-off type system-managed (no delete, no deactivate)', async () => {
    renderWithProviders(<LeavePage />, { route: '/leave?tab=types' });
    const row = (await screen.findByText('Comp off')).closest('tr')!;
    expect(within(row).getByText('System')).toBeInTheDocument();
    fireEvent.keyDown(within(row).getByRole('button', { name: /Actions/ }), { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: /Edit/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Deactivate/ })).not.toBeInTheDocument();
  });
});
