import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EmailLogSummaryDto, EmailMessageDetailDto, EmailMessageDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import EmailLogPage from './email-log-page';

const message = (over: Partial<EmailMessageDto> = {}): EmailMessageDto => ({
  id: 'e0000000-0000-4000-8000-000000000001', organizationId: 'org-1', kind: 'invitation', category: 'invitation', recipient: 'rakshitha@example.com', recipientUserId: null, recipientName: null,
  subject: null, status: 'sent', provider: 'resend', providerMessageId: 're_1', attempts: 1, lastError: null, invitationId: 'inv-1', createdAt: '2026-09-30T05:43:35Z', updatedAt: '2026-09-30T05:43:38Z',
  lastAttemptAt: '2026-09-30T05:43:38Z', nextAttemptAt: null, sentAt: '2026-09-30T05:43:38Z', deliveredAt: null, openedAt: null, clickedAt: null, bouncedAt: null, complainedAt: null, ...over,
});
const summary = (over: Partial<EmailLogSummaryDto> = {}): EmailLogSummaryDto => ({
  from: '2026-09-23T06:00:00Z', to: '2026-09-30T06:00:00Z', total: 4,
  byStatus: { queued: 1, retrying: 0, sent: 1, delivered: 1, delayed: 0, bounced: 1, complained: 0, failed: 0, skipped: 0 }, stalled: 0, oldestStalledAt: null, consoleSent: 0, ...over,
});
const ROWS = [
  message(),
  message({ id: 'e0000000-0000-4000-8000-000000000002', recipient: 'typo@example.com', status: 'bounced', lastError: 'Permanent / General: The recipient\'s mailbox does not exist.', bouncedAt: '2026-09-30T05:44:00Z' }),
  message({ id: 'e0000000-0000-4000-8000-000000000003', kind: 'notification', category: 'approval.pending', recipient: 'manager@example.com', recipientName: 'Maya Manager', subject: 'Leave awaiting your approval', status: 'delivered', invitationId: null }),
  message({ id: 'e0000000-0000-4000-8000-000000000004', recipient: 'revoked@example.com', status: 'skipped', lastError: 'invitation_revoked', provider: null, providerMessageId: null, sentAt: null }),
];

describe('E-mail log', () => {
  beforeEach(() => { resetApiMock(); grant('audit.view'); });

  it('lists every e-mail with where it stands, the provider\'s reason and the last 7 days', async () => {
    mockGet({ '/orgs/org-1/email-log': page(ROWS), '/orgs/org-1/email-log/summary': { data: summary() } });
    renderWithProviders(<EmailLogPage />);
    expect((await screen.findAllByText('rakshitha@example.com')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bounced').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Permanent / General: The recipient\'s mailbox does not exist.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Leave awaiting your approval').length).toBeGreaterThan(0);
    // a reason code reads as words
    expect(screen.getAllByText('The invitation was revoked before the e-mail went out.').length).toBeGreaterThan(0);
    expect(screen.getByText('Failed or bounced')).toBeInTheDocument();
    expect(screen.queryByTestId('email-log-stalled')).not.toBeInTheDocument();
    expect(screen.queryByTestId('email-log-console')).not.toBeInTheDocument();
  });

  it('warns when e-mails wait for a worker that is not sending, or never left the server', async () => {
    mockGet({ '/orgs/org-1/email-log': page([message({ status: 'queued', sentAt: null, provider: null, providerMessageId: null })]), '/orgs/org-1/email-log/summary': { data: summary({ stalled: 2, oldestStalledAt: '2026-09-30T05:00:00Z', consoleSent: 3 }) } });
    renderWithProviders(<EmailLogPage />);
    expect(await screen.findByTestId('email-log-stalled')).toHaveTextContent('2 e-mails have been waiting for more than 5 minutes');
    expect(screen.getByTestId('email-log-stalled')).toHaveTextContent('No worker is sending e-mails');
    expect(screen.getByTestId('email-log-console')).toHaveTextContent('3 e-mails in the last 7 days were not sent');
  });

  it('a console "send" reads not delivered', async () => {
    mockGet({ '/orgs/org-1/email-log': page([message({ provider: 'console', providerMessageId: null })]), '/orgs/org-1/email-log/summary': { data: summary() } });
    renderWithProviders(<EmailLogPage />);
    expect((await screen.findAllByText('Not delivered')).length).toBeGreaterThan(0);
  });

  it('filters by the invitation of the link it was opened from, and by a summary card', async () => {
    mockGet({ '/orgs/org-1/email-log': page([ROWS[0]!]), '/orgs/org-1/email-log/summary': { data: summary() } });
    renderWithProviders(<EmailLogPage />, { route: '/email-log?invitationId=inv-1' });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/email-log', expect.objectContaining({ invitationId: 'inv-1' })));
    fireEvent.click(screen.getByText('Delivered').closest('[role="button"]')!);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/email-log', expect.objectContaining({ status: 'delivered' })));
    // a card that counts several statuses filters all of them
    fireEvent.click(screen.getByText('Failed or bounced').closest('[role="button"]')!);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/email-log', expect.objectContaining({ status: 'failed,bounced,complained' })));
  });

  it('opens the timeline of an e-mail', async () => {
    const detail: EmailMessageDetailDto = {
      ...message({ status: 'delivered', deliveredAt: '2026-09-30T05:43:41Z' }),
      events: [
        { id: '1', event: 'queued', occurredAt: '2026-09-30T05:43:35Z', attempt: null, detail: null },
        { id: '2', event: 'attempt_failed', occurredAt: '2026-09-30T05:43:36Z', attempt: 1, detail: 'email send failed: rate limited' },
        { id: '3', event: 'sent', occurredAt: '2026-09-30T05:43:38Z', attempt: 2, detail: 'resend' },
        { id: '4', event: 'delivered', occurredAt: '2026-09-30T05:43:41Z', attempt: null, detail: null },
      ],
    };
    mockGet({ '/orgs/org-1/email-log': page([ROWS[0]!]), '/orgs/org-1/email-log/summary': { data: summary() }, [`/orgs/org-1/email-log/${detail.id}`]: { data: detail } });
    renderWithProviders(<EmailLogPage />);
    fireEvent.click((await screen.findAllByText('rakshitha@example.com'))[0]!);
    const timeline = await screen.findByTestId('email-timeline');
    expect(within(timeline).getByText('Queued')).toBeInTheDocument();
    expect(within(timeline).getByText('Attempt 1 failed — will retry')).toBeInTheDocument();
    expect(within(timeline).getByText('email send failed: rate limited')).toBeInTheDocument();
    expect(within(timeline).getByText('Accepted by resend')).toBeInTheDocument();
    expect(within(timeline).getByText('Delivered to the recipient\'s mail server')).toBeInTheDocument();
    expect(screen.getByTestId('email-detail')).toHaveTextContent('re_1');
  });
});
