import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import { RequestDetail } from './request-detail';
import { approvalRequest, approvalStep, leaveContext } from '../test-fixtures';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('approvals', en, ar);

const twoLevels = approvalRequest({
  id: 'r7', entityType: 'LEAVE', employeeName: 'Employee 9', employeeNumber: 'EMP9', requestedBy: 'u9', requestedByName: 'Report Nine', subjectUserId: 'u9',
  currentStep: 2, stepCount: 2, context: leaveContext(),
  steps: [
    approvalStep({ id: 's1', requestId: 'r7', stepNo: 1, status: 'APPROVED', actedBy: 'u5', actedByName: 'Team Approver', actedAt: '2024-03-02T10:00:00Z', actors: [{ userId: 'u5', userName: 'Team Approver', viaDelegationOf: null, viaDelegationOfName: null, resolutionPath: 'primary', decision: 'APPROVED', decidedAt: '2024-03-02T10:00:00Z', comment: 'Fine by me' }] }),
    approvalStep({ id: 's2', requestId: 'r7', stepNo: 2, approverType: 'HR_ADMIN', resolutionPath: 'hr_admin', actors: [{ userId: 'u7', userName: 'Fatma HR', viaDelegationOf: null, viaDelegationOfName: null, resolutionPath: 'hr_admin', decision: 'PENDING', decidedAt: null, comment: null }] }),
  ],
  abilities: { canDecide: false, canCancel: true, canReassign: true, canBypass: true, canRequestInfo: false, canAnswerInfo: false, actingAsDelegateOf: null },
  events: [
    { id: '1', at: '2024-03-02T08:00:00Z', actorUserId: 'u9', actorName: 'Report Nine', kind: 'submitted', detail: {} },
    { id: '2', at: '2024-03-02T10:00:00Z', actorUserId: 'u5', actorName: 'Team Approver', kind: 'step_approved', detail: { stepNo: 1, comment: 'Fine by me' } },
  ],
});

describe('RequestDetail — one request', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({ '/orgs/org-1/approvals/r7': { data: twoLevels } });
  });

  it('shows every level with its approvers and decisions, and the timeline with who did what', async () => {
    renderWithProviders(<RequestDetail requestId="r7" />);
    expect(await screen.findByText(/Employee 9/)).toBeInTheDocument();
    expect(screen.getByText(/Requested by Report Nine/)).toBeInTheDocument();
    expect(screen.getAllByText('Team Approver').length).toBeGreaterThan(0);
    expect(screen.getByText('Fatma HR')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText('Level 1 approved')).toBeInTheDocument();
  });

  it('approves as an exception only with a reason, and posts it to /bypass', async () => {
    apiMock.post.mockResolvedValue({ data: { ...twoLevels, status: 'APPROVED' } });
    renderWithProviders(<RequestDetail requestId="r7" />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve as exception/ }));
    const dialog = await screen.findByRole('dialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => /Approve as exception/.test(b.textContent ?? ''))!;
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'ok' } });
    expect(confirm).toBeDisabled(); // three characters at least, like the API
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'Family emergency' } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/r7/bypass', { reason: 'Family emergency' }));
  });

  it('hides the exception action when the API does not allow it', async () => {
    mockGet({ '/orgs/org-1/approvals/r7': { data: { ...twoLevels, abilities: { ...twoLevels.abilities, canBypass: false } } } });
    renderWithProviders(<RequestDetail requestId="r7" />);
    await screen.findByText(/Employee 9/);
    expect(screen.queryByRole('button', { name: /Approve as exception/ })).toBeNull();
  });
});
