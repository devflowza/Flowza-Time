import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { TimeAwayRequestDto, TimeAwayStatusDto } from '@flowza/contracts';
import { ApiError, apiMock, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { toast } from '@/lib/toast';
import './routes';
import { TimeAwayCard, TimeAwayToday } from './components/time-away-card';
import MyRequestsPage from './pages/requests-page';
import { backInstant, defaultBackTime, intervalTotals, personalLeft, timeAwayRefusal, windowInstants } from './time-away-model';

const ORG = 'org-1';
const EMP = '11111111-1111-4111-8111-111111111111';
const TZ = 'Asia/Muscat'; // UTC+4, no DST
const STATUS_PATH = `/orgs/${ORG}/me/time-away/status`;
/** 09:12 in Muscat. */
const NOW = Date.parse('2026-10-15T05:12:00Z');

const policy = (over: Partial<TimeAwayStatusDto['policy']> = {}): TimeAwayStatusDto['policy'] => ({
  enabled: true, stepOutFromPortal: true, returnBy: 'device_or_portal', officialCountsAsWorked: true, personalMonthlyQuotaMinutes: 240, personalMaxMinutes: 120, personalUsedMinutes: 90, inactiveReason: null, ...over,
});
const status = (over: Partial<TimeAwayStatusDto> = {}): TimeAwayStatusDto => ({
  date: '2026-10-15', timezone: TZ, serverTime: '2026-10-15T05:12:00Z', policy: policy(), away: null, onSite: true, canStepOut: true, canComeBack: false, intervals: [], requests: [], ...over,
});
const request = (over: Partial<TimeAwayRequestDto> = {}): TimeAwayRequestDto => ({
  id: 'ta1', employeeId: EMP, branchId: 'b1', attendanceDate: '2026-10-14', kind: 'OFFICIAL', source: 'request', startsAt: '2026-10-14T06:00:00Z', endsAt: '2026-10-14T07:30:00Z', returnedAt: null,
  minutes: 90, reason: 'Ministry of Labour visa renewal', destination: 'Al Khuwair', status: 'pending', approvalRequestId: 'req-1', approvalStatus: 'PENDING', decidedByName: null, decidedAt: null, decisionNote: null,
  createdAt: '2026-10-13T05:00:00Z', ...over,
});

beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = ORG; testState.employeeId = EMP; testState.timezone = TZ; });
afterEach(() => { vi.restoreAllMocks(); });

describe('time away model', () => {
  it('proposes a return an hour ahead on the next five minutes, in the employee\'s zone', () => {
    expect(defaultBackTime(NOW, TZ)).toBe('10:15');
    expect(defaultBackTime(Date.parse('2026-10-15T05:10:00Z'), TZ)).toBe('10:10');
  });

  it('reads a return time that has passed as the next day, and a window ending before it starts as crossing midnight', () => {
    expect(backInstant('2026-10-15', '10:15', TZ, NOW)).toBe('2026-10-15T06:15:00.000Z');
    expect(backInstant('2026-10-15', '01:00', TZ, Date.parse('2026-10-15T19:30:00Z'))).toBe('2026-10-15T21:00:00.000Z'); // 23:30 → 01:00 the next day
    expect(backInstant('2026-10-15', '', TZ, NOW)).toBeNull();
    expect(windowInstants('2026-10-20', '10:00', '11:30', TZ)).toEqual({ startsAt: '2026-10-20T06:00:00.000Z', endsAt: '2026-10-20T07:30:00.000Z', minutes: 90 });
    expect(windowInstants('2026-10-20', '23:00', '01:00', TZ)?.minutes).toBe(120);
    expect(windowInstants('2026-10-20', '10:00', '', TZ)).toBeNull();
  });

  it('counts what is left of the monthly quota, sums the intervals without the short gaps and names the refusals', () => {
    expect(personalLeft(policy())).toBe(150);
    expect(personalLeft(policy({ personalUsedMinutes: 300 }))).toBe(0);
    expect(personalLeft(policy({ personalMonthlyQuotaMinutes: null }))).toBeNull();
    const at = '2026-10-15T06:00:00Z';
    expect(intervalTotals([
      { kind: 'OFFICIAL', startAt: at, endAt: at, minutes: 60, requestId: 'r1' }, { kind: 'PERMISSION', startAt: at, endAt: at, minutes: 30, requestId: 'r2' },
      { kind: 'BREAK', startAt: at, endAt: at, minutes: 20, requestId: null }, { kind: 'UNAPPROVED', startAt: at, endAt: at, minutes: 25, requestId: null }, { kind: 'SHORT', startAt: at, endAt: at, minutes: 3, requestId: null },
    ])).toEqual({ away: 135, official: 60, permission: 30, break: 20, unapproved: 25 });
    expect(timeAwayRefusal(new ApiError(409, 'CONFLICT', 'x', 'r', { reason: 'ALREADY_AWAY' }))).toBe('ALREADY_AWAY');
    expect(timeAwayRefusal(new ApiError(409, 'CONFLICT', 'x', 'r', { reason: 'SOMETHING_ELSE' }))).toBeNull();
  });
});

describe('TimeAwayCard (check-in page)', () => {
  it('steps out with the kind, the expected return in the employee\'s zone, the reason and an idempotency key', async () => {
    mockGet({ [STATUS_PATH]: { data: status() } });
    apiMock.post.mockResolvedValue({ data: request({ source: 'step_out', startsAt: '2026-10-15T05:12:00Z', endsAt: '2026-10-15T06:15:00Z' }) });
    const success = vi.spyOn(toast, 'success');
    renderWithProviders(<TimeAwayCard nowMs={NOW} />);
    fireEvent.click(await screen.findByTestId('time-away-step-out'));
    const dialog = await screen.findByRole('dialog');
    // the personal card shows the month's quota and the longest single permission
    expect(within(dialog).getByTestId('personal-quota')).toHaveTextContent('2h 30m of 4h 00m left this month · At most 2h 00m at a time');
    expect(within(dialog).getByLabelText(/Expected back/)).toHaveValue('10:15');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Personal permission/ }));
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'Bank appointment' } });
    fireEvent.change(within(dialog).getByLabelText(/^Destination/), { target: { value: 'Bank Muscat, Ruwi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Step out now' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/time-away/step-out`, {
      kind: 'PERSONAL', expectedBackAt: '2026-10-15T06:15:00.000Z', reason: 'Bank appointment', destination: 'Bank Muscat, Ruwi', channel: 'web', idempotencyKey: expect.any(String),
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith('You stepped out at 09:12. Expected back at 10:15.'));
  });

  it('checks the personal limits before sending: the longest permission and the reason', async () => {
    mockGet({ [STATUS_PATH]: { data: status() } });
    renderWithProviders(<TimeAwayCard nowMs={NOW} />);
    fireEvent.click(await screen.findByTestId('time-away-step-out'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Personal permission/ }));
    fireEvent.change(within(dialog).getByLabelText(/Expected back/), { target: { value: '12:30' } }); // 3h 18m
    fireEvent.click(within(dialog).getByRole('button', { name: 'Step out now' }));
    expect(await within(dialog).findByText('Personal permission is at most 2h 00m at a time.')).toBeInTheDocument();
    expect(within(dialog).getByText('Write at least 3 characters.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('explains a refusal of the API in the employee\'s words', async () => {
    mockGet({ [STATUS_PATH]: { data: status() } });
    apiMock.post.mockRejectedValue(new ApiError(422, 'VALIDATION_ERROR', 'quota', 'req-9', { reason: 'TIME_AWAY_QUOTA', quotaMinutes: 240, usedMinutes: 200 }));
    const error = vi.spyOn(toast, 'error');
    renderWithProviders(<TimeAwayCard nowMs={NOW} />);
    fireEvent.click(await screen.findByTestId('time-away-step-out'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'Client visit' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Step out now' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Not enough personal permission left this month: 3h 20m of 4h 00m is already used or waiting.'));
  });

  it('while away: says since when and until when, and records "I\'m back" when the policy allows the portal', async () => {
    mockGet({ [STATUS_PATH]: { data: status({
      onSite: false, canStepOut: false, canComeBack: true,
      away: { requestId: 'ta2', kind: 'OFFICIAL', since: '2026-10-15T04:30:00Z', expectedBackAt: '2026-10-15T05:00:00Z', reason: 'Client', destination: 'Omantel HQ', status: 'pending' },
    }) } });
    apiMock.post.mockResolvedValue({ data: request({ id: 'ta2', returnedAt: '2026-10-15T05:12:00Z' }) });
    renderWithProviders(<TimeAwayCard nowMs={NOW} />);
    const banner = await screen.findByTestId('time-away-away');
    expect(banner).toHaveTextContent('You stepped out at 08:30 for Official duty');
    expect(banner).toHaveTextContent('Expected back at 09:00');
    expect(within(banner).getByTestId('time-away-overdue')).toHaveTextContent('12m past your expected return');
    expect(banner).toHaveTextContent('Omantel HQ');
    expect(screen.queryByTestId('time-away-step-out')).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: /I'm back/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/time-away/back`, { channel: 'web', idempotencyKey: expect.any(String) }));
  });

  it('"I\'m back" keeps one idempotency key per step-out, so a retry after a lost response replays; a failure refreshes the status', async () => {
    mockGet({ [STATUS_PATH]: { data: status({
      onSite: false, canStepOut: false, canComeBack: true,
      away: { requestId: 'ta2', kind: 'PERSONAL', since: '2026-10-15T04:30:00Z', expectedBackAt: '2026-10-15T06:00:00Z', reason: 'Bank', destination: null, status: 'approved' },
    }) } });
    apiMock.post.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'offline')).mockResolvedValueOnce({ data: request({ id: 'ta2', returnedAt: '2026-10-15T05:12:00Z' }) });
    vi.spyOn(toast, 'error');
    const statusReads = () => apiMock.get.mock.calls.filter(([path]) => path === STATUS_PATH).length;
    renderWithProviders(<TimeAwayCard nowMs={NOW} />);
    const button = await screen.findByTestId('time-away-back');
    const before = statusReads();
    fireEvent.click(button);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    // the failed attempt re-reads the status instead of leaving the banner up until the next minute's refetch
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByTestId('time-away-back')).toBeEnabled());
    fireEvent.click(screen.getByTestId('time-away-back'));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(2));
    const keyOf = (i: number) => (apiMock.post.mock.calls[i]![1] as { idempotencyKey: string }).idempotencyKey;
    expect(keyOf(0)).toEqual(expect.any(String));
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('a return recorded on the terminal only: no "I\'m back", the hint instead', async () => {
    mockGet({ [STATUS_PATH]: { data: status({
      policy: policy({ returnBy: 'device' }), onSite: false, canStepOut: false, canComeBack: false,
      away: { requestId: 'ta2', kind: 'PERSONAL', since: '2026-10-15T04:30:00Z', expectedBackAt: '2026-10-15T06:00:00Z', reason: 'Bank', destination: null, status: 'approved' },
    }) } });
    renderWithProviders(<TimeAwayCard nowMs={NOW} />);
    expect(await screen.findByTestId('time-away-back-on-device')).toHaveTextContent('Check in on the terminal when you are back.');
    expect(screen.queryByRole('button', { name: /I'm back/ })).toBeNull();
    expect(screen.queryByTestId('time-away-overdue')).toBeNull();
  });

  it('lists today\'s classified intervals with their kinds and today\'s requests', async () => {
    mockGet({ [STATUS_PATH]: { data: status({
      intervals: [
        { kind: 'OFFICIAL', startAt: '2026-10-15T05:00:00Z', endAt: '2026-10-15T06:00:00Z', minutes: 60, requestId: 'ta1' },
        { kind: 'UNAPPROVED', startAt: '2026-10-15T07:00:00Z', endAt: '2026-10-15T07:25:00Z', minutes: 25, requestId: null },
      ],
      requests: [request({ attendanceDate: '2026-10-15', startsAt: '2026-10-15T05:00:00Z', endsAt: '2026-10-15T06:00:00Z', status: 'approved' })],
    }) } });
    renderWithProviders(<TimeAwayCard nowMs={NOW} />);
    const rows = await screen.findAllByTestId('away-interval');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Official duty');
    expect(rows[0]).toHaveTextContent('09:00 – 10:00');
    expect(rows[1]).toHaveTextContent('Unapproved');
    expect(rows[1]).toHaveTextContent('25m');
    const today = screen.getByTestId('time-away-today-requests');
    expect(today).toHaveTextContent('Official duty');
    expect(today).toHaveTextContent('Approved');
  });

  it('says why nothing is measured under a first / last policy, and stays hidden when time away is off', async () => {
    mockGet({ [STATUS_PATH]: { data: status({ canStepOut: false, policy: policy({ inactiveReason: 'FIRST_LAST_INTERPRETATION' }) }) } });
    const { unmount } = renderWithProviders(<TimeAwayCard nowMs={NOW} />);
    expect(await screen.findByTestId('time-away-inactive')).toHaveTextContent(/keeps only your first and last punch/);
    expect(screen.queryByTestId('time-away-step-out')).toBeNull();
    unmount();

    mockGet({ [STATUS_PATH]: { data: status({ canStepOut: false, policy: policy({ enabled: false, inactiveReason: 'DISABLED' }) }) } });
    renderWithProviders(<TimeAwayCard nowMs={NOW} />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(STATUS_PATH));
    expect(screen.queryByTestId('time-away-card')).toBeNull();
  });
});

describe('TimeAwayToday (portal home)', () => {
  it('sums today\'s away time by kind when the policy measures it', async () => {
    mockGet({ [STATUS_PATH]: { data: status({
      away: { requestId: 'ta2', kind: 'OFFICIAL', since: '2026-10-15T07:00:00Z', expectedBackAt: '2026-10-15T08:00:00Z', reason: 'Client', destination: null, status: 'pending' },
      intervals: [
        { kind: 'OFFICIAL', startAt: '2026-10-15T05:00:00Z', endAt: '2026-10-15T06:00:00Z', minutes: 60, requestId: 'ta1' },
        { kind: 'UNAPPROVED', startAt: '2026-10-15T06:30:00Z', endAt: '2026-10-15T06:50:00Z', minutes: 20, requestId: null },
      ],
    }) } });
    renderWithProviders(<TimeAwayToday />);
    const card = await screen.findByTestId('home-time-away');
    expect(card).toHaveTextContent('Time away today');
    expect(card).toHaveTextContent('Stepped out since 11:00');
    expect(within(card).getByText('Away').nextSibling).toHaveTextContent('1h 20m');
    expect(within(card).getByText('Official duty').nextSibling).toHaveTextContent('1h 00m');
    expect(within(card).getByText('Unapproved').nextSibling).toHaveTextContent('20m');
  });

  it('stays out of the way when the status cannot be read', async () => {
    renderWithProviders(<TimeAwayToday />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(screen.queryByTestId('home-time-away')).toBeNull();
  });
});

describe('My requests → Time away', () => {
  it('lists the requests with their window, kind, length and decision, and withdraws a pending one', async () => {
    mockGet({
      [STATUS_PATH]: { data: status() },
      [`/orgs/${ORG}/me/time-away`]: { data: [
        request(),
        request({ id: 'ta3', kind: 'PERSONAL', source: 'step_out', status: 'approved', returnedAt: '2026-10-14T07:10:00Z', decidedByName: 'Mansoor', decisionNote: 'OK' }),
      ] },
    });
    apiMock.post.mockResolvedValue({ data: request({ status: 'cancelled' }) });
    renderWithProviders(<MyRequestsPage />, { route: '/my/requests?tab=time-away' });
    const rows = await screen.findAllByTestId('time-away-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('10:00 – 11:30');
    expect(rows[0]).toHaveTextContent('Official duty');
    expect(rows[0]).toHaveTextContent('Planned');
    expect(rows[0]).toHaveTextContent('1h 30m');
    expect(rows[1]).toHaveTextContent('Back at 11:10');
    expect(rows[1]).toHaveTextContent('Stepped out');
    expect(rows[1]).toHaveTextContent('Mansoor');
    expect(within(rows[1]!).queryByRole('button', { name: /Withdraw/ })).toBeNull();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: /Withdraw/ }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/time-away/ta1/cancel`, {}));
  });

  it('requests a planned window: the day and the times in the employee\'s zone become UTC instants', async () => {
    mockGet({ [STATUS_PATH]: { data: status() }, [`/orgs/${ORG}/me/time-away`]: { data: [] } });
    apiMock.post.mockResolvedValue({ data: request() });
    renderWithProviders(<MyRequestsPage />, { route: '/my/requests?tab=time-away' });
    expect(await screen.findByText('No time-away requests')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('time-away-request'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Day/), { target: { value: '2026-10-20' } });
    fireEvent.change(within(dialog).getByLabelText(/^From/), { target: { value: '10:00' } });
    fireEvent.change(within(dialog).getByLabelText(/^To/), { target: { value: '11:30' } });
    expect(within(dialog).getByTestId('ta-duration')).toHaveTextContent('Duration: 1h 30m');
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'Visa renewal at the ministry' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/time-away`, { kind: 'OFFICIAL', startsAt: '2026-10-20T06:00:00.000Z', endsAt: '2026-10-20T07:30:00.000Z', reason: 'Visa renewal at the ministry' }));
  });

  it('offers the tab only when the policy measures time away (or a link asks for it)', async () => {
    mockGet({ [STATUS_PATH]: { data: status({ policy: policy({ enabled: false, inactiveReason: 'DISABLED' }) }) }, [`/orgs/${ORG}/me/attendance/notes`]: { data: [] } });
    renderWithProviders(<MyRequestsPage />);
    await screen.findByRole('tab', { name: 'Reasons' });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(STATUS_PATH));
    expect(screen.queryByRole('tab', { name: 'Time away' })).toBeNull();
  });
});
