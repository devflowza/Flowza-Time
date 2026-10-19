import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { DEFAULT_ATTENDANCE_SETTINGS } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import AttendanceSection from './attendance-section';

// what GET /settings/attendance returns: every key resolved server-side, defaults filled in
const current = { ...DEFAULT_ATTENDANCE_SETTINGS, defaultShiftId: null };

describe('AttendanceSection (policy parity)', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({ '/orgs/org-1/settings/attendance': { data: current }, '/orgs/org-1/shifts': page([]) }); });

  it('shows the policy groups with their defaults, validates against the shared schema and PUTs the whole group', async () => {
    apiMock.put.mockImplementation(async (_path: string, value: unknown) => ({ data: value }));
    renderWithProviders(<AttendanceSection />);
    const grace = await screen.findByLabelText(/Day-close grace/);
    expect(grace).toHaveValue(2);
    expect(screen.getByLabelText(/Explanation grace/)).toHaveValue(3);
    expect(screen.getByLabelText(/Duplicate punch guard/)).toHaveValue(60);
    expect(screen.getByLabelText(/Attendance target/)).toHaveValue(90);
    expect(screen.getByRole('switch', { name: /Web check-in/ })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /Detect missed punches/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Deduct unexcused days automatically/ })).not.toBeChecked();
    expect(screen.getByLabelText(/Charge leave in this order/)).toHaveValue('AL, CL');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    // out of range: the day-close grace is 0–7 days
    fireEvent.change(grace, { target: { value: '9' } });
    fireEvent.click(save);
    await screen.findByText(/<=7/);
    expect(apiMock.put).not.toHaveBeenCalled();

    // a half-filled time window is refused too
    fireEvent.change(grace, { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Check-in window start'), { target: { value: '06:00' } });
    fireEvent.click(save);
    await screen.findByText('Expected HH:mm');
    expect(apiMock.put).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Check-in window end'), { target: { value: '11:30' } });
    fireEvent.click(screen.getByRole('switch', { name: /Web check-in/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Deduct unexcused days automatically/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Require a reason for a late arrival/ }));
    fireEvent.change(screen.getByLabelText(/IP allow-list/), { target: { value: '10.0.0.0/8\n192.168.1.20' } });
    fireEvent.change(screen.getByLabelText(/Charge leave in this order/), { target: { value: 'al, cl, ul' } });
    fireEvent.change(screen.getByLabelText(/Full day \(hours\)/), { target: { value: '7.5' } });
    fireEvent.click(save);
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/attendance', {
      ...current,
      selfService: { ...current.selfService, webCheckIn: true, checkInWindow: { start: '06:00', end: '11:30' }, ipAllowList: ['10.0.0.0/8', '192.168.1.20'] },
      missedPunch: { ...current.missedPunch, dayCloseGraceDays: 1 },
      unexcused: { ...current.unexcused, autoDeductEnabled: true, leaveTypePriority: ['AL', 'CL', 'UL'] }, // codes are normalised to upper case by the schema
      notes: { ...current.notes, requireReasonForLate: true },
      stats: { ...current.stats, fullDayHours: 7.5 },
    });
  });

  it('4-P2-8 4-P2-9 4-P2-18 says the channel switches are client-declared, offers the regularisation switch (on by default) and says the IP list needs the edge', async () => {
    apiMock.put.mockImplementation(async (_path: string, value: unknown) => ({ data: value }));
    renderWithProviders(<AttendanceSection />);
    const regularisation = await screen.findByRole('switch', { name: /Regularisation requests/ });
    expect(regularisation).toBeChecked();
    expect(screen.getByTestId('att-ss-channel-note')).toHaveTextContent(/not a security control/);
    expect(screen.getByText(/EDGE_SHARED_SECRET/)).toBeInTheDocument();
    fireEvent.click(regularisation);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/attendance', { ...current, selfService: { ...current.selfService, regularisation: false } });
  });

  it('the excuse deadline is optional (empty = none, 1–60 days) and the hint names the grace actually in force', async () => {
    apiMock.put.mockImplementation(async (_path: string, value: unknown) => ({ data: value }));
    renderWithProviders(<AttendanceSection />);
    const deadline = await screen.findByLabelText(/Deadline to give a reason/);
    expect(deadline).toHaveValue(null);
    // the day close waits for the larger of the two graces (2 and 3 by default)
    expect(screen.getByTestId('att-effective-grace')).toHaveTextContent('The day close marks an unexplained day after 3 days — the larger of the day-close grace (2) and the explanation grace (3).');
    fireEvent.change(screen.getByLabelText(/Day-close grace/), { target: { value: '5' } });
    expect(screen.getByTestId('att-effective-grace')).toHaveTextContent('after 5 days — the larger of the day-close grace (5) and the explanation grace (3)');
    fireEvent.change(screen.getByLabelText(/Day-close grace/), { target: { value: '2' } });
    fireEvent.change(deadline, { target: { value: '61' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(deadline).toHaveAttribute('aria-invalid', 'true'));
    expect(apiMock.put).not.toHaveBeenCalled();
    fireEvent.change(deadline, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/attendance', { ...current, unexcused: { ...current.unexcused, excuseDeadlineDays: 4 } });
  });

  it('clearing the excuse deadline saves "no deadline" (null), not a stale number', async () => {
    mockGet({ '/orgs/org-1/settings/attendance': { data: { ...current, unexcused: { ...current.unexcused, excuseDeadlineDays: 7 } } }, '/orgs/org-1/shifts': page([]) });
    apiMock.put.mockImplementation(async (_path: string, value: unknown) => ({ data: value }));
    renderWithProviders(<AttendanceSection />);
    const deadline = await screen.findByLabelText(/Deadline to give a reason/);
    expect(deadline).toHaveValue(7);
    fireEvent.change(deadline, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/attendance', { ...current, unexcused: { ...current.unexcused, excuseDeadlineDays: null } });
  });

  it('rejects an invalid address in the IP allow-list', async () => {
    renderWithProviders(<AttendanceSection />);
    const ips = await screen.findByLabelText(/IP allow-list/);
    fireEvent.change(ips, { target: { value: '10.0.0.0/8\nnot-an-ip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ips).toHaveAttribute('aria-invalid', 'true'));
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('is read-only without organization.manage', async () => {
    grant('organization.view');
    renderWithProviders(<AttendanceSection />);
    expect(await screen.findByLabelText(/Day-close grace/)).toBeDisabled();
    expect(screen.getByRole('switch', { name: /Deduct unexcused days automatically/ })).toBeDisabled();
    expect(screen.getByLabelText(/IP allow-list/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
