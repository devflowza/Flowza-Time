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
import { decisionToast } from '../labels';
import { DecisionDialog } from './decision-dialog';
import { approvalRequest, approvalStep, leaveContext } from '../test-fixtures';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('approvals', en, ar);

describe('DecisionDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({}); });

  it('requires a comment to reject and posts the decision for the current level to /approvals/:id/decide', async () => {
    apiMock.post.mockResolvedValue({ data: { ...approvalRequest({ status: 'REJECTED' }), noop: false, terminal: true } });
    const onClose = vi.fn();
    renderWithProviders(<DecisionDialog request={approvalRequest({ currentStep: 2, stepCount: 2 })} decision="REJECT" timezone="Asia/Muscat" onClose={onClose} />);
    expect(screen.getByText('Reject request')).toBeInTheDocument();
    expect(screen.getAllByText('Ali').length).toBeGreaterThan(0);
    expect(screen.getByText(/Level 2 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/new punch → 01 Mar 08:30/)).toBeInTheDocument(); // proposed vs original in the branch timezone
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: 'No evidence' } });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/req-1/decide', { stepNo: 2, decision: 'REJECT', comment: 'No evidence' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('approves without a comment and shows the leave context (range, days, balance after)', async () => {
    apiMock.post.mockResolvedValue({ data: { ...approvalRequest({ status: 'APPROVED' }), noop: false, terminal: true } });
    renderWithProviders(<DecisionDialog request={approvalRequest({ entityType: 'LEAVE', context: leaveContext() })} decision="APPROVE" timezone="Asia/Muscat" onClose={() => {}} />);
    expect(screen.getByText('Annual Leave')).toBeInTheDocument();
    expect(screen.getByText('3 days')).toBeInTheDocument();
    expect(screen.getByText('17 of 30 days left after this')).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/req-1/decide', { stepNo: 1, decision: 'APPROVE', comment: undefined }));
  });

  it('P0-1 tells an organisation-wide approver that the decision is an override filling one seat, and names it', async () => {
    apiMock.post.mockResolvedValue({ data: { ...approvalRequest(), noop: false, terminal: false } });
    const request = approvalRequest({
      abilities: { canDecide: true, canCancel: false, canReassign: false, canBypass: false, canRequestInfo: true, canAnswerInfo: false, actingAsDelegateOf: null, decideVia: 'override' },
      steps: [approvalStep({ mode: 'ALL', actors: [
        { userId: 'u7', userName: 'Fatma HR', viaDelegationOf: null, viaDelegationOfName: null, onBehalfOfUserId: null, onBehalfOfName: null, resolutionPath: 'hr_admin', decision: 'PENDING', decidedAt: null, comment: null },
        { userId: 'u8', userName: 'Salim HR', viaDelegationOf: null, viaDelegationOfName: null, onBehalfOfUserId: null, onBehalfOfName: null, resolutionPath: 'hr_admin', decision: 'PENDING', decidedAt: null, comment: null },
      ] })],
    });
    renderWithProviders(<DecisionDialog request={request} decision="APPROVE" timezone="Asia/Muscat" onClose={() => {}} />);
    expect(screen.getByTestId('decision-seat-hint')).toHaveTextContent(/organisation-wide override that fills the seat of Fatma HR/);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/req-1/decide', { stepNo: 1, decision: 'APPROVE', comment: undefined }));
  });

  it('P0-1 shows no override note to a seated approver', () => {
    renderWithProviders(<DecisionDialog request={approvalRequest({ abilities: { canDecide: true, canCancel: false, canReassign: false, canBypass: false, canRequestInfo: true, canAnswerInfo: false, actingAsDelegateOf: null, decideVia: 'actor' } })} decision="APPROVE" timezone="Asia/Muscat" onClose={() => {}} />);
    expect(screen.queryByTestId('decision-seat-hint')).toBeNull();
  });

  it('says what the decision did: the request, the level, or only this vote', () => {
    const t = (k: string) => k;
    const base = approvalRequest();
    expect(decisionToast(t, { ...base, status: 'APPROVED', noop: false, terminal: true }, 'APPROVE', 1)).toBe('decision.approved');
    expect(decisionToast(t, { ...base, currentStep: 2, stepCount: 2, noop: false, terminal: false }, 'APPROVE', 1)).toBe('decision.stepApproved');
    expect(decisionToast(t, { ...base, noop: false, terminal: false }, 'APPROVE', 1)).toBe('decision.approvalRecorded');
    expect(decisionToast(t, { ...base, noop: false, terminal: false }, 'REJECT', 1)).toBe('decision.rejectionRecorded');
    expect(decisionToast(t, { ...base, status: 'REJECTED', noop: false, terminal: true }, 'REJECT', 1)).toBe('decision.rejected');
    expect(decisionToast(t, { ...base, noop: true, terminal: false }, 'APPROVE', 1)).toBe('decision.noop');
  });
});
