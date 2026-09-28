import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ApprovalActorDto, ApprovalRequestDto } from '@flowza/contracts';

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
import { decisionToast, waitingSeats } from '../labels';
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

  const hrSeat = (userId: string, userName: string): ApprovalActorDto => ({ userId, userName, viaDelegationOf: null, viaDelegationOfName: null, onBehalfOfUserId: null, onBehalfOfName: null, resolutionPath: 'hr_admin', decision: 'PENDING', decidedAt: null, comment: null });
  const overrideAbilities = (extra: Partial<ApprovalRequestDto['abilities']> = {}): ApprovalRequestDto['abilities'] => ({ canDecide: true, canCancel: false, canReassign: false, canBypass: false, canRequestInfo: true, canAnswerInfo: false, actingAsDelegateOf: null, decideVia: 'override', ...extra });
  const seats = [{ userId: 'u7', userName: 'Fatma HR' }, { userId: 'u8', userName: 'Salim HR' }];

  it('P0-1 tells an organisation-wide approver that the decision is an override filling one seat, names it, and sends that seat', async () => {
    apiMock.post.mockResolvedValue({ data: { ...approvalRequest(), noop: false, terminal: false } });
    // ANY: any one approval settles the level, so the API's first waiting seat is the target — shown, then named in the call
    const request = approvalRequest({ abilities: overrideAbilities({ mustChooseSeat: false }), steps: [approvalStep({ mode: 'ANY', actors: [hrSeat('u7', 'Fatma HR'), hrSeat('u8', 'Salim HR')], pendingSeats: seats })] });
    renderWithProviders(<DecisionDialog request={request} decision="APPROVE" timezone="Asia/Muscat" onClose={() => {}} />);
    expect(screen.getByTestId('decision-seat-hint')).toHaveTextContent(/organisation-wide override that fills the seat of Fatma HR/);
    expect(screen.queryByLabelText(/Deciding for/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/req-1/decide', { stepNo: 1, decision: 'APPROVE', comment: undefined, onBehalfOfUserId: 'u7' }));
  });

  it('P2-13 an override on a level that needs several approvals asks whom it is deciding for, and sends that seat', async () => {
    apiMock.post.mockResolvedValue({ data: { ...approvalRequest(), noop: false, terminal: false } });
    const request = approvalRequest({ abilities: overrideAbilities({ mustChooseSeat: true }), steps: [approvalStep({ mode: 'ALL', actors: [hrSeat('u7', 'Fatma HR'), hrSeat('u8', 'Salim HR')], pendingSeats: seats })] });
    renderWithProviders(<DecisionDialog request={request} decision="APPROVE" timezone="Asia/Muscat" onClose={() => {}} />);
    expect(screen.getByTestId('decision-seat-hint')).toHaveTextContent(/choose whose seat it fills — the others still decide/);
    const approve = screen.getByRole('button', { name: 'Approve' });
    // nothing is decided until the approver says whose seat it is
    expect(approve).toBeDisabled();
    expect(screen.getByText('Choose the approver whose seat your decision fills.')).toBeInTheDocument();
    const decidingFor = screen.getByLabelText(/Deciding for/);
    fireEvent.keyDown(decidingFor, { key: 'ArrowDown' });
    expect(await screen.findByRole('option', { name: 'Fatma HR' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('option', { name: 'Salim HR' }));
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/req-1/decide', { stepNo: 1, decision: 'APPROVE', comment: undefined, onBehalfOfUserId: 'u8' }));
  });

  it('P2-13 reads the waiting seats from an older payload without pendingSeats: seats by id, no extra hands, no decided seats', () => {
    const extraHand: ApprovalActorDto = { ...hrSeat('u1', 'Late Helper'), resolutionPath: 'escalated' };
    const decided: ApprovalActorDto = { ...hrSeat('u2', 'Done HR'), decision: 'APPROVED' };
    const request = approvalRequest({ abilities: overrideAbilities({ mustChooseSeat: false }), steps: [approvalStep({ mode: 'ANY', actors: [hrSeat('u8', 'Salim HR'), extraHand, decided, hrSeat('u7', 'Fatma HR')] })] });
    expect(waitingSeats(request)).toEqual([{ userId: 'u7', userName: 'Fatma HR' }, { userId: 'u8', userName: 'Salim HR' }]);
    renderWithProviders(<DecisionDialog request={request} decision="APPROVE" timezone="Asia/Muscat" onClose={() => {}} />);
    expect(screen.getByTestId('decision-seat-hint')).toHaveTextContent(/fills the seat of Fatma HR/);
  });

  it('P2-13 an escalated approver on such a level chooses too', () => {
    const request = approvalRequest({ abilities: overrideAbilities({ decideVia: 'escalated', mustChooseSeat: true }), steps: [approvalStep({ mode: 'QUORUM', requiredCount: 2, actors: [hrSeat('u7', 'Fatma HR'), hrSeat('u8', 'Salim HR')], pendingSeats: seats })] });
    renderWithProviders(<DecisionDialog request={request} decision="REJECT" timezone="Asia/Muscat" onClose={() => {}} />);
    expect(screen.getByTestId('decision-seat-hint')).toHaveTextContent(/added when this level became overdue/);
    expect(screen.getByLabelText(/Deciding for/)).toBeInTheDocument();
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
