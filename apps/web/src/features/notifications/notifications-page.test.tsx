import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grant, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { NotificationsPage } from './notifications-page';

const n = (id: string, type: string, title: string, data: Record<string, unknown>, link: string | null) => ({ id, category: 'APPROVAL', type, title, body: null, data, link, readAt: null, createdAt: '2026-09-28T06:00:00Z', organizationId: 'org-1' });

/** HR portal Prompt 5 (Finance B-66): a notification opens the page its READER works on. */
describe('NotificationsPage routing', () => {
  beforeEach(() => {
    resetApiMock();
    mockGet({ '/me/notifications': page([
      n('1', 'approval.pending', 'Leave awaiting your approval', { requestId: 'req-1', entityType: 'LEAVE', employeeId: 'e5' }, '/approvals/requests/req-1'),
      n('2', 'approval.decided', 'Leave approved', { requestId: 'req-2', entityType: 'LEAVE', employeeId: 'e4' }, '/approvals/requests/req-2'),
      n('3', 'attendance.note_submitted', 'Attendance reason from Salma', { employeeId: 'e5' }, '/attendance/notes'),
    ]) });
  });

  it('sends a line manager without an approve key to their team queue, and their own outcome to /my', async () => {
    testState.employeeId = 'e4'; testState.teamSize = 2;
    grant('dashboard.view', 'employee.view_team');
    renderWithProviders(<NotificationsPage />);
    expect(await screen.findByRole('link', { name: 'Leave awaiting your approval' })).toHaveAttribute('href', '/team?tab=approvals');
    expect(screen.getByRole('link', { name: 'Attendance reason from Salma' })).toHaveAttribute('href', '/team?tab=approvals');
    expect(screen.getByRole('link', { name: 'Leave approved' })).toHaveAttribute('href', '/my/leave');
  });

  it('opens the request panel for an approver', async () => {
    testState.employeeId = 'e9'; testState.teamSize = 0;
    grant('dashboard.view', 'leave.approve', 'attendance.approve');
    renderWithProviders(<NotificationsPage />);
    expect(await screen.findByRole('link', { name: 'Leave awaiting your approval' })).toHaveAttribute('href', '/approvals?request=req-1');
    expect(screen.getByRole('link', { name: 'Attendance reason from Salma' })).toHaveAttribute('href', '/attendance/notes');
  });
});
