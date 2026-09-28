import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { ApprovalEmailPreviewDto } from '@flowza/contracts';
import i18n from '@/lib/i18n';
import { ApiError, apiMock, grant, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import EmailActionPage from './email-action-page';

registerNamespace('approvals', en, ar);

const TOKEN = 'tok-0123456789abcdef-approve';
const route = (action = 'APPROVE') => `/approvals/email-action?org=org-9&action=${action}&token=${TOKEN}`;
const preview = (over: Partial<ApprovalEmailPreviewDto> = {}): ApprovalEmailPreviewDto => ({
  requestId: 'req-1', action: 'APPROVE', entityType: 'LEAVE', employeeName: 'Sara Nasser', date: '2026-10-04', endDate: '2026-10-05', leaveTypeName: 'Casual Leave', leaveTypeNameAr: 'إجازة عارضة',
  stepNo: 1, stepCount: 2, currentStep: 1, status: 'PENDING', actionable: true, expiresAt: '2026-10-01T00:00:00Z', ...over,
});
const postsTo = (path: string) => apiMock.post.mock.calls.filter(([p]) => p === path);

describe('EmailActionPage (notifications review 8-P0-1: the request first, then the decision)', () => {
  beforeEach(() => { resetApiMock(); grant(); });
  afterEach(async () => { await i18n.changeLanguage('en'); });

  it('8-P0-1 shows what the link is about — read from the request by the preview — and decides nothing until the approver confirms', async () => {
    apiMock.post.mockImplementation(async (path: string) => {
      if (path.endsWith('/email-action/preview')) return { data: preview() };
      return { data: { id: 'req-1', status: 'APPROVED' } };
    });
    renderWithProviders(<EmailActionPage />, { route: route() });
    const summary = await screen.findByTestId('email-action-summary');
    expect(summary).toHaveTextContent('Leave');
    expect(summary).toHaveTextContent('Sara Nasser');
    expect(summary).toHaveTextContent('Casual Leave');
    expect(summary).toHaveTextContent('04 Oct 2026 → 05 Oct 2026');
    expect(summary).toHaveTextContent('Level 1 of 2');
    // the preview is the only call on load: read-only, the token's own organisation, the link's action
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-9/approvals/email-action/preview', { token: TOKEN, action: 'APPROVE' });
    expect(postsTo('/orgs/org-9/approvals/email-action')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(postsTo('/orgs/org-9/approvals/email-action')).toHaveLength(1));
    expect(postsTo('/orgs/org-9/approvals/email-action')[0]![1]).toEqual({ token: TOKEN, action: 'APPROVE', comment: undefined });
    expect(await screen.findByText(/the request is now Approved/)).toBeInTheDocument();
  });

  it('8-P0-1 in Arabic the leave type reads in Arabic', async () => {
    await i18n.changeLanguage('ar');
    apiMock.post.mockResolvedValue({ data: preview() });
    renderWithProviders(<EmailActionPage />, { route: route() });
    const summary = await screen.findByTestId('email-action-summary');
    expect(summary).toHaveTextContent('إجازة عارضة');
    expect(summary).not.toHaveTextContent('Casual Leave');
  });

  it('8-P0-1 a rejection needs its comment; a link whose level no longer waits offers the request, not a button', async () => {
    apiMock.post.mockResolvedValue({ data: preview({ action: 'REJECT' }) });
    const first = renderWithProviders(<EmailActionPage />, { route: route('REJECT') });
    await screen.findByTestId('email-action-summary');
    expect(screen.getByRole('button', { name: /Reject/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: 'No cover that week' } });
    expect(screen.getByRole('button', { name: /Reject/ })).toBeEnabled();
    first.unmount();

    resetApiMock();
    apiMock.post.mockResolvedValue({ data: preview({ actionable: false, status: 'APPROVED' }) });
    renderWithProviders(<EmailActionPage />, { route: route() });
    expect(await screen.findByText(/no longer waits for your decision/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the request' })).toHaveAttribute('href', '/approvals/requests/req-1');
  });

  it('8-P0-1 a used, expired or foreign link shows the refusal and never offers the decision', async () => {
    apiMock.post.mockRejectedValue(new ApiError(409, 'INVALID_STATE', 'This approval link has already been used.'));
    renderWithProviders(<EmailActionPage />, { route: route() });
    expect(await screen.findByText(/already been used/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(apiMock.post).toHaveBeenCalledTimes(1);
  });

  it('an incomplete link calls nothing', async () => {
    renderWithProviders(<EmailActionPage />, { route: '/approvals/email-action?org=org-9&action=MAYBE&token=x' });
    expect(await screen.findByText(/incomplete or not meant for this account/)).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});
