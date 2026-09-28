import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import ApprovalsPage from './approvals-page';
import { InboxRoute } from '../components/route-guards';
import { approvalRequest, approvalStep, leaveContext } from '../test-fixtures';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('approvals', en, ar);

const decidable = approvalRequest({ id: 'r1', employeeName: 'Ali', requestedBy: 'u2', requestedByName: 'Sara' });
// the test harness signs in as `u1`: this one is the caller's own request (not decidable, withdraw instead)
const own = approvalRequest({ id: 'r2', employeeName: 'Mona', requestedBy: 'u1', requestedByName: 'Dev', currentStep: 2, stepCount: 2, abilities: { canDecide: false, canCancel: true, canReassign: false, canBypass: false, canRequestInfo: false, canAnswerInfo: false, actingAsDelegateOf: null } });
const decided = approvalRequest({ id: 'r3', entityType: 'LEAVE', employeeName: 'Omar', status: 'APPROVED', completedAt: '2024-03-03T09:00:00Z', context: leaveContext(), steps: [approvalStep({ requestId: 'r3', status: 'APPROVED' })], abilities: { canDecide: false, canCancel: false, canReassign: false, canBypass: false, canRequestInfo: false, canAnswerInfo: false, actingAsDelegateOf: null } });

describe('ApprovalsPage — unified inbox', () => {
  beforeEach(() => {
    resetApiMock(); grantAll(); testState.teamSize = 0; testState.employeeId = null; testState.approvals = { actionable: 0, delegatedToMe: false };
    mockGet({
      '/orgs/org-1/approvals': (q: Record<string, unknown> | undefined) => page(q?.['view'] === 'history' ? [decided] : [decidable, own]),
      '/orgs/org-1/approvals/mine': page([own, decided]),
      '/orgs/org-1/approval-delegations': { data: [] },
      '/orgs/org-1/branches': page([]),
    });
  });

  it('offers Approve / Reject where the API says the caller may decide, never on the caller\'s own request', async () => {
    renderWithProviders(<ApprovalsPage />, { route: '/approvals' });
    expect((await screen.findAllByText('Ali')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mona').length).toBeGreaterThan(0);
    // one row is decidable: table + card fallback each render the buttons once
    expect(screen.getAllByRole('button', { name: /Approve/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Reject/ })).toHaveLength(2);
    expect(screen.getAllByText('Your request').length).toBeGreaterThan(0);
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/approvals', expect.objectContaining({ scope: 'mine', view: 'pending' }));
  });

  it('switches Pending ↔ History and shows the decision status', async () => {
    renderWithProviders(<ApprovalsPage />, { route: '/approvals' });
    await screen.findAllByText('Ali');
    fireEvent.mouseDown(screen.getByRole('tab', { name: /History/ }));
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    expect((await screen.findAllByText('Omar')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: /Approve/ })).toHaveLength(0);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/approvals', expect.objectContaining({ view: 'history' })));
  });

  it('shows the scope chips a caller can use: a line manager gets Mine + My team, HR gets Everyone too', async () => {
    grant('attendance.approve', 'attendance.view_team', 'leave.view_team');
    testState.teamSize = 2; testState.employeeId = 'e9';
    const first = renderWithProviders(<ApprovalsPage />, { route: '/approvals' });
    await screen.findAllByText('Ali');
    expect(screen.getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'My team' }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/approvals', expect.objectContaining({ scope: 'team' })));
    expect(screen.queryByRole('button', { name: 'Everyone' })).not.toBeInTheDocument();
    first.unmount();
    grantAll();
    renderWithProviders(<ApprovalsPage />, { route: '/approvals' });
    await screen.findAllByText('Ali');
    expect(screen.getByRole('button', { name: 'Everyone' })).toBeInTheDocument();
  });

  it('P1-2 approves several selected requests in one call, each line naming the level it was on — the API decides each one and reports refusals', async () => {
    apiMock.post.mockResolvedValue({ data: { results: [{ requestId: 'r1', ok: true, status: 'APPROVED', noop: false, code: null, message: null }, { requestId: 'r2', ok: false, status: null, noop: false, code: 'FORBIDDEN', message: 'You cannot approve or reject your own request; cancel it instead.' }], succeeded: 1, failed: 1 } });
    renderWithProviders(<ApprovalsPage />, { route: '/approvals' });
    await screen.findAllByText('Ali');
    const boxes = screen.getAllByRole('checkbox', { name: 'Select row' });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    fireEvent.click(await screen.findByRole('button', { name: /Approve selected/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/bulk-decide', { items: [{ requestId: 'r1', stepNo: 1 }, { requestId: 'r2', stepNo: 2 }], decision: 'APPROVE', comment: undefined }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approve selected/ })).toBeNull());
  });

  it('P1-6 opens the inbox to a member who holds no approve key, and lists what waits for them', async () => {
    grant('dashboard.view'); // an employee-role delegate / named approver: no approve key, no reports
    testState.approvals = { actionable: 1, delegatedToMe: true };
    renderWithProviders(<InboxRoute />, { route: '/approvals' });
    expect((await screen.findAllByText('Ali')).length).toBeGreaterThan(0);
    expect(screen.queryByText('You do not have permission to view this page.')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Approve/ }).length).toBeGreaterThan(0);
  });

  it('P1-6 lists "My requests" — what the caller filed or what is about them — from /approvals/mine', async () => {
    grant('dashboard.view');
    renderWithProviders(<ApprovalsPage />, { route: '/approvals' });
    await screen.findAllByText('Ali');
    fireEvent.mouseDown(screen.getByRole('tab', { name: /My requests/ }));
    fireEvent.click(screen.getByRole('tab', { name: /My requests/ }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/approvals/mine', expect.objectContaining({ page: 1 })));
    expect((await screen.findAllByText('Omar')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mona').length).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText('Search employee name or number')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Select row' })).toBeNull();
  });

  it('filters by request type with chips and searches by employee name or number', async () => {
    renderWithProviders(<ApprovalsPage />, { route: '/approvals' });
    await screen.findAllByText('Ali');
    expect(screen.getByRole('button', { name: 'All types' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/approvals', expect.objectContaining({ entityType: 'LEAVE' })));
    fireEvent.change(screen.getByPlaceholderText('Search employee name or number'), { target: { value: 'EMP10' } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/approvals', expect.objectContaining({ search: 'EMP10', entityType: 'LEAVE' })), { timeout: 2000 });
  });

  it('exports History as CSV for report.export holders only', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-disposition': 'attachment; filename="approvals-history-2024-03-03.csv"' }), blob: async () => new Blob(['csv']) }));
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    try {
      renderWithProviders(<ApprovalsPage />, { route: '/approvals?view=history' });
      await screen.findAllByText('Omar');
      fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
      expect(url).toBe('http://localhost:4000/api/v1/orgs/org-1/approvals/history/export?scope=mine');
      expect(init.headers['Authorization']).toBe('Bearer token');
      await waitFor(() => expect(saved).toEqual(['approvals-history-2024-03-03.csv']));
      expect(createObjectURL).toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); click.mockRestore(); }
  });

  it('shows no export without report.export, and none on the Pending view', async () => {
    grant('attendance.approve', 'attendance.view');
    const first = renderWithProviders(<ApprovalsPage />, { route: '/approvals?view=history' });
    await screen.findAllByText('Omar');
    expect(screen.queryByRole('button', { name: /Export CSV/ })).toBeNull();
    first.unmount();
    grantAll();
    renderWithProviders(<ApprovalsPage />, { route: '/approvals' });
    await screen.findAllByText('Ali');
    expect(screen.queryByRole('button', { name: /Export CSV/ })).toBeNull();
  });
});
