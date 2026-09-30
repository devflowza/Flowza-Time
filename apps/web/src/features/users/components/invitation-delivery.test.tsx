import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import type { InvitationDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grant, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { invitationDeliveryStatus, isDeliveryInFlight } from '../api';
import { DELIVERY_STALE_AFTER_MS, LiveInvitationDelivery } from './invitation-delivery';

const invitation = (over: Partial<InvitationDto> = {}): InvitationDto => ({
  id: 'inv-1', organizationId: 'org-1', email: 'rakshitha02220@gmail.com', roleId: 'r', roleName: 'Employee', allBranches: true, branchIds: [], invitedBy: 'u1', invitedByName: 'Dev', employeeId: null, employeeNumber: null,
  expiresAt: '2099-10-07T11:13:00Z', acceptedAt: null, createdAt: '2026-09-30T05:43:35Z', deliverySentAt: null, deliveryStatus: 'queued', ...over,
});

describe('the invitation e-mail status never spins on a status it does not refresh', () => {
  it('derives one status for display and polling', () => {
    expect(invitationDeliveryStatus({ deliveryStatus: 'queued', deliverySentAt: null })).toBe('queued');
    // an API that predates the status (web deployed ahead of it): queued until the worker stamps the send, then sent
    expect(invitationDeliveryStatus({ deliveryStatus: undefined, deliverySentAt: null })).toBe('queued');
    expect(invitationDeliveryStatus({ deliveryStatus: undefined, deliverySentAt: '2026-09-30T05:43:38Z' })).toBe('sent');
    // a row a worker older than the status e-mailed: `none`, with the send stamped
    expect(invitationDeliveryStatus({ deliveryStatus: 'none', deliverySentAt: '2026-09-30T05:43:38Z' })).toBe('sent');
    expect(invitationDeliveryStatus({ deliveryStatus: 'none', deliverySentAt: null })).toBe('none');
    expect(invitationDeliveryStatus({ deliveryStatus: 'failed', deliverySentAt: null })).toBe('failed');
    // …and the one that shows "Sending…" is the one that polls
    expect(isDeliveryInFlight({ deliveryStatus: undefined, deliverySentAt: null, expiresAt: '2099-01-01T00:00:00Z' })).toBe(true);
    expect(isDeliveryInFlight({ deliveryStatus: undefined, deliverySentAt: '2026-09-30T05:43:38Z', expiresAt: '2099-01-01T00:00:00Z' })).toBe(false);
    expect(isDeliveryInFlight({ deliveryStatus: 'queued', deliverySentAt: null, expiresAt: '2020-01-01T00:00:00Z' })).toBe(false);
  });
});

describe('LiveInvitationDelivery', () => {
  beforeEach(() => { resetApiMock(); grant('user.view', 'user.manage', 'audit.view'); });
  afterEach(() => { vi.useRealTimers(); testState.allBranches = true; });

  it('follows an older API\'s invitation to "E-mailed" instead of spinning', async () => {
    let sent = false;
    mockGet({ '/orgs/org-1/invitations': () => ({ data: [invitation({ deliveryStatus: undefined, deliverySentAt: sent ? '2026-09-30T05:43:38Z' : null })] }) });
    const view = renderWithProviders(<LiveInvitationDelivery invitation={invitation({ deliveryStatus: undefined })} />);
    expect(await screen.findByText('Sending…')).toBeInTheDocument();
    sent = true;
    await act(async () => { await view.client.invalidateQueries(); });
    await waitFor(() => expect(screen.getByTestId('invitation-delivery')).toHaveAttribute('data-status', 'sent'));
    expect(screen.getByTestId('invitation-delivery')).toHaveTextContent(/E-mailed/);
  });

  it('says the e-mail service has not picked it up after a minute, and links to its e-mail log', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet({ '/orgs/org-1/invitations': { data: [invitation()] } });
    renderWithProviders(<LiveInvitationDelivery invitation={invitation()} />);
    expect(await screen.findByText('Sending…')).toBeInTheDocument();
    expect(screen.queryByTestId('invitation-delivery-stale')).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(DELIVERY_STALE_AFTER_MS + 1_000); });
    const stale = await screen.findByTestId('invitation-delivery-stale');
    expect(stale).toHaveTextContent('has not picked this e-mail up yet');
    expect(screen.getByRole('link', { name: 'Open the e-mail log' })).toHaveAttribute('href', '/email-log?invitationId=inv-1');
  });

  it('offers the log only to members who may read it (audit.view on every branch)', async () => {
    testState.allBranches = false;
    mockGet({ '/orgs/org-1/invitations': { data: [invitation({ deliveryStatus: 'sent', deliverySentAt: '2026-09-30T05:43:38Z', deliveryProvider: 'resend' })] } });
    renderWithProviders(<LiveInvitationDelivery invitation={invitation()} />);
    await waitFor(() => expect(screen.getByTestId('invitation-delivery')).toHaveAttribute('data-status', 'sent'));
    expect(screen.queryByTestId('invitation-email-log')).not.toBeInTheDocument();
  });

  it('links a sent invitation to its timeline in the log', async () => {
    mockGet({ '/orgs/org-1/invitations': { data: [invitation({ deliveryStatus: 'sent', deliverySentAt: '2026-09-30T05:43:38Z', deliveryProvider: 'resend' })] } });
    renderWithProviders(<LiveInvitationDelivery invitation={invitation()} />);
    expect(await screen.findByTestId('invitation-email-log')).toHaveAttribute('href', '/email-log?invitationId=inv-1');
  });
});
