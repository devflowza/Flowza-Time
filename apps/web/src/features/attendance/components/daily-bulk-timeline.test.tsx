import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import type { AttendanceTimelineDto } from '@flowza/contracts';
import { DailyView } from './daily-view';
import { usePendingEdits } from '../pending-edits';
import { TimelineDrawer } from './timeline-drawer';

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const rec = (id: string, employeeId: string, name: string, status: string) => ({
  id, employeeId, employeeName: name, employeeNumber: id.toUpperCase(), branchId: 'b1', branchName: 'Muscat', attendanceDate: '2026-09-10', timezone: 'Asia/Muscat', status, flags: [],
  shiftId: null, shiftName: 'Day shift', expectedStartAt: null, expectedEndAt: null, firstInAt: null, lastOutAt: null, workedMinutes: 0, breakMinutes: 0, scheduledMinutes: 540,
  lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null, punchCount: 0, calculationVersion: 1, computedAt: '2026-09-10T18:00:00Z', lockedAt: null, lopDays: 0,
});
const daily = { data: [rec('r1', E1, 'Ali Hassan', 'ABSENT'), rec('r2', E2, 'Sara Nasser', 'ABSENT')], meta: { page: 1, pageSize: 25, total: 2, totalPages: 1, byStatus: { ABSENT: 2 }, missingPunch: 0 } };

describe('DailyView — Auto / Manual chips and bulk Set status', () => {
  beforeEach(() => {
    resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat';
    mockGet({
      '/orgs/org-1/attendance/daily': daily,
      '/orgs/org-1/attendance/manual-statuses': { data: [{ employeeId: E2, date: '2026-09-10', status: 'ABSENT', correctionId: 'c9', reason: 'No show', appliedAt: '2026-09-10T19:00:00Z' }] },
      '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/shifts': page([]), '/orgs/org-1/employees': page([]),
    });
  });

  it('marks each row Auto or Manual and files one SET_STATUS per selected day with one reason', async () => {
    apiMock.post.mockResolvedValue({ data: { results: [{ employeeId: E1, date: '2026-09-10', ok: true, correctionId: 'c1', approval: 'AUTO_APPROVED' }, { employeeId: E2, date: '2026-09-10', ok: false, error: { code: 'PERIOD_LOCKED', message: 'The period is locked.' } }], succeeded: 1, failed: 1, autoApproved: 1, pending: 0 } });
    renderWithProviders(<DailyView />, { route: '/attendance?tab=daily&date=2026-09-10' });
    const table = (await screen.findAllByRole('table'))[0]!;
    const rows = await within(table).findAllByRole('row');
    const ali = rows.find((r) => r.textContent?.includes('Ali Hassan'))!;
    const sara = rows.find((r) => r.textContent?.includes('Sara Nasser'))!;
    await waitFor(() => expect(within(sara).getByTestId('status-source-MANUAL')).toBeInTheDocument());
    expect(within(ali).getByTestId('status-source-AUTO')).toBeInTheDocument();

    fireEvent.click(within(ali).getByRole('checkbox', { name: 'Select row' }));
    fireEvent.click(within(sara).getByRole('checkbox', { name: 'Select row' }));
    fireEvent.click(await screen.findByRole('button', { name: /Set status/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('2 day(s) selected');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByText('Choose a status.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Status' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Holiday' }));
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'National day declared late' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/attendance/bulk-status');
    expect(body).toEqual({ items: [{ employeeId: E1, date: '2026-09-10' }, { employeeId: E2, date: '2026-09-10' }], status: 'HOLIDAY', reason: 'National day declared late' });
    // per-item results: the locked day is reported, the other one was saved
    const result = await screen.findByTestId('bulk-result');
    expect(result).toHaveTextContent('1 saved, 1 not saved');
    expect(result).toHaveTextContent('Sara Nasser');
    expect(result).toHaveTextContent('PERIOD_LOCKED');
  });

  it('hides selection and bulk actions from members who may not edit records', async () => {
    grant('attendance.view');
    renderWithProviders(<DailyView />, { route: '/attendance?tab=daily&date=2026-09-10' });
    const table = (await screen.findAllByRole('table'))[0]!;
    await within(table).findAllByText('Ali Hassan');
    expect(within(table).queryByRole('checkbox', { name: 'Select row' })).not.toBeInTheDocument();
  });
});

describe('DailyView — a day just saved in Add / Edit record (field report 2026-10-02: it showed the old outcome until recalculated)', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat'; usePendingEdits.setState({ edits: {} }); });

  it('says the day is updating until a record computed after the edit arrives, polling meanwhile, then settles it', async () => {
    let computedAt = '2026-09-10T18:00:00Z';
    mockGet({
      '/orgs/org-1/attendance/daily': () => ({ ...daily, data: [{ ...rec('r1', E1, 'Ali Hassan', 'ABSENT'), computedAt }, rec('r2', E2, 'Sara Nasser', 'ABSENT')] }),
      '/orgs/org-1/attendance/manual-statuses': { data: [] },
      '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/shifts': page([]), '/orgs/org-1/employees': page([]),
    });
    usePendingEdits.getState().mark(E1, '2026-09-10', '2026-09-11T08:00:00Z');
    renderWithProviders(<DailyView />, { route: '/attendance?tab=daily&date=2026-09-10' });
    const table = (await screen.findAllByRole('table'))[0]!;
    const rows = await within(table).findAllByRole('row');
    const ali = rows.find((r) => r.textContent?.includes('Ali Hassan'))!;
    expect(await within(ali).findByTestId('row-updating')).toHaveTextContent(/Updating/);
    expect(within(rows.find((r) => r.textContent?.includes('Sara Nasser'))!).queryByTestId('row-updating')).not.toBeInTheDocument();
    // the worker recalculated the day: the next poll brings the record computed after the edit
    computedAt = '2026-09-11T08:00:03Z';
    await waitFor(() => expect(screen.queryAllByTestId('row-updating')).toHaveLength(0), { timeout: 6000 });
    expect(usePendingEdits.getState().edits).toEqual({});
  });
});

const timeline: AttendanceTimelineDto = {
  employeeId: E1, employeeNumber: '1001', employeeName: 'Ali Hassan', date: '2026-09-10', timezone: 'Asia/Muscat', recordId: 'r1', status: 'PRESENT',
  window: { from: '2026-09-10T00:00:00Z', to: '2026-09-11T00:00:00Z' },
  events: [
    { id: 'e1', punchedAt: '2026-09-10T04:02:10Z', eventType: 'PUNCH', source: 'DEVICE', verificationMethod: 'FINGERPRINT', deviceId: 'd1', deviceName: 'Main gate', voidedAt: null, voidedByCorrectionId: null, correctionId: null, note: null, rawTransactionId: 't1', role: 'IN' },
    { id: 'e2', punchedAt: '2026-09-10T04:03:00Z', eventType: 'PUNCH', source: 'DEVICE', verificationMethod: 'FINGERPRINT', deviceId: 'd1', deviceName: 'Main gate', voidedAt: null, voidedByCorrectionId: null, correctionId: null, note: null, rawTransactionId: 't2', role: 'DUPLICATE' },
    { id: 'e3', punchedAt: '2026-09-10T13:30:00Z', eventType: 'PUNCH_OUT', source: 'CORRECTION', verificationMethod: null, deviceId: null, deviceName: null, voidedAt: null, voidedByCorrectionId: null, correctionId: 'c1', note: null, rawTransactionId: null, role: 'OUT' },
  ],
  raw: [
    { id: 't1', punchedAt: '2026-09-10T04:02:10Z', deviceId: 'd1', deviceName: 'Main gate', deviceEmployeeId: '77', direction: 'IN', verificationMethod: 'FINGERPRINT', source: 'DEVICE', processingStatus: 'normalized', processingError: null, receivedAt: '2026-09-10T04:02:30Z', deviceLocalTime: null, clockSkewSeconds: null, facts: {} },
    { id: 't9', punchedAt: '2026-09-10T13:29:00Z', deviceId: null, deviceName: null, deviceEmployeeId: null, direction: null, verificationMethod: null, source: 'MOBILE', processingStatus: 'normalized', processingError: null, receivedAt: '2026-09-10T13:29:05Z', deviceLocalTime: null, clockSkewSeconds: null, facts: { channel: 'mobile', geofenceVerdict: 'flagged', distanceM: 412.4, accuracy: 18, isMock: true } },
  ],
};

describe('TimelineDrawer', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; });

  it('lists the day\'s events with the engine\'s role and the raw device rows with their facts', async () => {
    mockGet({ '/orgs/org-1/attendance/timeline': (q: Record<string, unknown> | undefined) => { expect(q).toEqual({ employeeId: E1, date: '2026-09-10' }); return { data: timeline }; } });
    const onEdit = vi.fn();
    renderWithProviders(<TimelineDrawer day={{ employeeId: E1, date: '2026-09-10' }} onClose={() => {}} onEdit={onEdit} />);
    const drawer = await screen.findByTestId('timeline-drawer');
    const events = await within(drawer).findAllByTestId('timeline-event');
    expect(events).toHaveLength(3);
    expect(events[0]).toHaveTextContent('08:02:10');
    expect(events[0]).toHaveTextContent('IN');
    expect(events[1]).toHaveTextContent('Duplicate');
    expect(events[2]).toHaveTextContent('via correction');
    const raw = within(drawer).getAllByTestId('timeline-raw');
    expect(raw).toHaveLength(2);
    expect(raw[1]).toHaveTextContent('Mobile check-in');
    expect(raw[1]).toHaveTextContent('Outside geofence (flagged)');
    expect(raw[1]).toHaveTextContent('412 m away');
    expect(raw[1]).toHaveTextContent('Mock location reported');
    fireEvent.click(within(drawer).getByRole('button', { name: /Edit record/ }));
    expect(onEdit).toHaveBeenCalledWith({ employeeId: E1, date: '2026-09-10', employeeName: 'Ali Hassan' });
  });

  it('says so when the caller may not see raw device rows', async () => {
    mockGet({ '/orgs/org-1/attendance/timeline': { data: { ...timeline, raw: null } } });
    renderWithProviders(<TimelineDrawer day={{ employeeId: E1, date: '2026-09-10', employeeName: 'Ali Hassan' }} onClose={() => {}} />);
    expect(await screen.findByText(/raw-data permission/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit record/ })).not.toBeInTheDocument();
  });
});
