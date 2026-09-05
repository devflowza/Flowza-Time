import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import ApprovalsPage from './approvals-page';
import type { InboxItem } from '../api';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('approvals', en, ar);

const correction = (id: string, requestedBy: string, employeeName: string): NonNullable<InboxItem['correction']> => ({
  id, employeeId: 'e1', branchId: 'b1', attendanceDate: '2024-03-01', type: 'ADD_PUNCH', originalEventId: null, originalPunchedAt: null, proposedPunchedAt: '2024-03-01T04:30:00Z', proposedEventType: 'PUNCH', proposedStatus: null,
  reason: 'Forgot badge', status: 'PENDING', requestedBy, approvalRequestId: `req-${id}`, appliedEventId: null, appliedAt: null, rejectionReason: null, createdAt: '2024-03-02T08:00:00Z', updatedAt: '2024-03-02T08:00:00Z', employeeName, employeeNumber: '1001',
});
const item = (id: string, requestedBy: string, requestedByName: string, employeeName: string): InboxItem => ({
  stepId: `s-${id}`, stepNo: 1, approverType: 'ROLE', requestId: `req-${id}`, entityType: 'ATTENDANCE_CORRECTION', entityId: id, branchId: 'b1', employeeId: 'e1', currentStep: 1, requestedBy, requestedByName, createdAt: '2024-03-02T08:00:00Z', correction: correction(id, requestedBy, employeeName),
});

describe('ApprovalsPage — pending inbox', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    // the test harness signs in as user `u1`
    mockGet({ '/orgs/org-1/approvals/inbox': page([item('c1', 'u2', 'Sara', 'Ali'), item('c2', 'u1', 'Dev', 'Mona')]), '/orgs/org-1/branches': page([]) });
  });

  it('offers Approve / Reject for other people’s requests but never for the caller’s own request', async () => {
    renderWithProviders(<ApprovalsPage />, { route: '/approvals' });
    expect((await screen.findAllByText('Ali')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mona').length).toBeGreaterThan(0);
    // one row (Sara's request) is decidable: table + card fallback each render the buttons once
    expect(screen.getAllByRole('button', { name: /Approve/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Reject/ })).toHaveLength(2);
    // the caller's own request shows the separation-of-duties hint and a link to cancel it from Corrections
    expect(screen.getAllByText('Your request').length).toBeGreaterThan(0);
    const cancelLink = screen.getByRole('link', { name: /Cancel in Corrections/ });
    expect(cancelLink).toHaveAttribute('href', '/corrections?status=PENDING');
    expect(screen.getAllByText('You cannot approve or reject your own request. Cancel it from Corrections instead.').length).toBeGreaterThan(0);
  });
});
