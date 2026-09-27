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
import { approvalRequest, approvalStep, leaveContext } from '../test-fixtures';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('approvals', en, ar);

const decidable = approvalRequest({ id: 'r1', employeeName: 'Ali', requestedBy: 'u2', requestedByName: 'Sara' });
// the test harness signs in as `u1`: this one is the caller's own request (not decidable, withdraw instead)
const own = approvalRequest({ id: 'r2', employeeName: 'Mona', requestedBy: 'u1', requestedByName: 'Dev', abilities: { canDecide: false, canCancel: true, canReassign: false, canRequestInfo: false, canAnswerInfo: false, actingAsDelegateOf: null } });
const decided = approvalRequest({ id: 'r3', entityType: 'LEAVE', employeeName: 'Omar', status: 'APPROVED', completedAt: '2024-03-03T09:00:00Z', context: leaveContext(), steps: [approvalStep({ requestId: 'r3', status: 'APPROVED' })], abilities: { canDecide: false, canCancel: false, canReassign: false, canRequestInfo: false, canAnswerInfo: false, actingAsDelegateOf: null } });

describe('ApprovalsPage — unified inbox', () => {
  beforeEach(() => {
    resetApiMock(); grantAll(); testState.teamSize = 0; testState.employeeId = null;
    mockGet({
      '/orgs/org-1/approvals': (q: Record<string, unknown> | undefined) => page(q?.['view'] === 'history' ? [decided] : [decidable, own]),
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
});
