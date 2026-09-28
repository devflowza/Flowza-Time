import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DateTime } from 'luxon';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { AttendanceNoteDto, RegularisationDto, SelfDayDto, SelfPunchPreviewDto, SelfPunchStatusDto, SelfStatsDto } from '@flowza/contracts';
import { todayIso } from '@/lib/format';
import { ApiError, apiMock, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { Sidebar } from '@/components/layout/sidebar';
import './routes';
import CheckInPage from './pages/checkin-page';
import MyRequestsPage from './pages/requests-page';
import MyShiftPage from './pages/shift-page';
import MyAttendancePage from './pages/attendance-page';
import { HomePunchCard, PendingSelfItems } from './components/home-attendance';
import { NoteDialog } from './components/note-dialog';
import { SelfStats } from './components/self-stats';
import { createMemoryStore, setPunchQueueStore, type PunchQueueStore, type QueuedPunch } from './offline-queue';
import { sendOutcomeOf } from './use-offline-punches';
import { toast } from '@/lib/toast';

const EMP = '11111111-1111-4111-8111-111111111111';
const ORG = 'org-1';

const status = (over: Partial<SelfPunchStatusDto> = {}): SelfPunchStatusDto => ({
  date: '2026-09-27', timezone: 'Asia/Muscat', serverTime: '2026-09-27T04:00:00Z', punches: [], today: null, lastDirection: null, canCheckIn: true, canCheckOut: false, blockers: [],
  policy: { webCheckIn: true, mobileCheckIn: false, requireGeofence: 'flag', allowSelfieCheckIn: false, checkInWindow: null, checkOutWindow: null, outOfWindowAction: 'flag', duplicatePunchSeconds: 60, ipRestricted: false },
  grant: { openAttendance: false, selfieRequired: false }, selfieAvailable: false,
  fences: [{ id: 'f1', name: 'HQ', latitude: 23.588, longitude: 58.3829, radiusM: 150, hasPolygon: false, enforcement: 'soft_warn', scope: 'org' }],
  ...over,
});
const preview = (over: Partial<SelfPunchPreviewDto> = {}): SelfPunchPreviewDto => ({
  verdict: { verdict: 'allowed', reason: 'inside', geofenceId: 'f1', geofenceName: 'HQ', distanceM: 0, scope: 'org', enforcement: 'soft_warn' }, outOfWindow: false, refusals: [], wouldBeFlagged: false, ...over,
});
const note = (over: Partial<AttendanceNoteDto> = {}): AttendanceNoteDto => ({
  id: 'n1', employeeId: EMP, attendanceDate: '2026-09-20', category: 'client_visit', note: 'At the client', status: 'pending', submittedAt: '2026-09-21T05:00:00Z',
  reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewReason: null, reviewVia: null, infoRequestMessage: null, infoRequestedAt: null, payEffectDays: null, lossOfPay: false,
  deductedLeaveTypeCode: null, deductedLeaveTypeName: null, approvalRequestId: 'req-1', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1, excusedAt: null,
  createdAt: '2026-09-21T05:00:00Z', updatedAt: '2026-09-21T05:00:00Z', ...over,
});

function mockGeolocation(fix: { latitude: number; longitude: number; accuracy: number } | 'denied') {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: vi.fn((ok: PositionCallback, fail: PositionErrorCallback) => (fix === 'denied' ? fail({ code: 1, message: 'denied' } as GeolocationPositionError) : ok({ coords: { ...fix }, timestamp: Date.now() } as GeolocationPosition))) },
  });
}

beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = ORG; testState.employeeId = EMP; testState.userId = 'u1'; setPunchQueueStore(createMemoryStore()); });
afterEach(() => { setPunchQueueStore(null); testState.settings = {}; testState.userId = 'u1'; vi.restoreAllMocks(); });

describe('portal navigation (Prompt 4)', () => {
  it('adds check-in, requests and shift to "My workspace"', () => {
    renderWithProviders(<Sidebar />);
    for (const name of ['Check in / out', 'My requests', 'My shift']) expect(screen.getByRole('link', { name })).toBeInTheDocument();
  });
});

describe('CheckInPage', () => {
  it('reads the location, shows the verdict and punches with the server clock', async () => {
    mockGeolocation({ latitude: 23.5881, longitude: 58.383, accuracy: 12 });
    mockGet({ [`/orgs/${ORG}/me/punch/status`]: { data: status() } });
    apiMock.post.mockImplementation((path: string) => {
      if (path.endsWith('/me/punch/preview')) return Promise.resolve({ data: preview() });
      if (path.endsWith('/me/punch')) return Promise.resolve({ data: { replayed: false, punch: { id: 'p1', punchedAt: '2026-09-27T04:00:05Z', direction: 'in', source: 'SELF_SERVICE', channel: 'web', verdict: 'allowed', deviceName: null, processingStatus: 'pending' }, verdict: preview().verdict, outOfWindow: false, flagged: false } });
      return Promise.reject(new ApiError(404, 'NOT_FOUND', 'x'));
    });
    renderWithProviders(<CheckInPage />);
    const banner = await screen.findByTestId('verdict-banner');
    expect(banner).toHaveAttribute('data-verdict', 'allowed');
    expect(banner).toHaveTextContent('Inside HQ');
    expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/punch/preview`, { direction: 'in', channel: 'web', lat: 23.5881, lng: 58.383, accuracy: 12 });
    fireEvent.click(screen.getByTestId('punch-button'));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/punch`, expect.objectContaining({ direction: 'in', channel: 'web', lat: 23.5881, lng: 58.383, accuracy: 12, idempotencyKey: expect.any(String) })));
  });

  it('explains a flagged punch and a refused mock location', async () => {
    mockGeolocation({ latitude: 23.6, longitude: 58.4, accuracy: 10 });
    mockGet({ [`/orgs/${ORG}/me/punch/status`]: { data: status() } });
    apiMock.post.mockResolvedValueOnce({ data: preview({ verdict: { verdict: 'denied_mock', reason: 'mock_location', geofenceId: 'f1', geofenceName: 'HQ', distanceM: 1400, scope: 'org', enforcement: 'hard_block' }, refusals: ['MOCK_LOCATION'] }) });
    renderWithProviders(<CheckInPage />);
    const banner = await screen.findByTestId('verdict-banner');
    expect(banner).toHaveTextContent('Simulated location detected');
    expect(banner).toHaveTextContent('Location spoofing apps and mock locations are detected and recorded.');
    expect(screen.getByTestId('punch-button')).toBeDisabled();
  });

  it('shows the organisation blockers and never offers the punch', async () => {
    mockGeolocation('denied');
    mockGet({ [`/orgs/${ORG}/me/punch/status`]: { data: status({ blockers: ['WEB_CHECKIN_DISABLED'], canCheckIn: false }) } });
    apiMock.post.mockResolvedValue({ data: preview({ refusals: ['WEB_CHECKIN_DISABLED'] }) });
    renderWithProviders(<CheckInPage />);
    expect(await screen.findByText('Web check-in is turned off for your organisation.')).toBeInTheDocument();
    expect(await screen.findByText(/Location access is blocked/)).toBeInTheDocument();
    expect(screen.getByTestId('punch-button')).toBeDisabled();
  });

  it('keeps a punch taken offline on the device and sends it when asked', async () => {
    mockGeolocation({ latitude: 23.5881, longitude: 58.383, accuracy: 12 });
    mockGet({ [`/orgs/${ORG}/me/punch/status`]: { data: status() } });
    let online = false;
    const punches: unknown[] = [];
    apiMock.post.mockImplementation((path: string, body: unknown) => {
      if (path.endsWith('/me/punch/preview')) return Promise.resolve({ data: preview() });
      if (path.endsWith('/me/punch')) {
        if (!online) return Promise.reject(new ApiError(0, 'NETWORK_ERROR', 'offline'));
        punches.push(body);
        return Promise.resolve({ data: { replayed: false, punch: { id: 'p1', punchedAt: '2026-09-27T04:30:00Z', direction: 'in', source: 'SELF_SERVICE', channel: 'web', verdict: 'allowed', deviceName: null, processingStatus: 'pending' }, verdict: preview().verdict, outOfWindow: false, flagged: false } });
      }
      return Promise.reject(new ApiError(404, 'NOT_FOUND', 'x'));
    });
    renderWithProviders(<CheckInPage />);
    await screen.findByTestId('verdict-banner');
    fireEvent.click(screen.getByTestId('punch-button'));
    const queue = await screen.findByTestId('offline-queue');
    expect(within(queue).getByText('Saved on this device (1)')).toBeInTheDocument();
    online = true;
    fireEvent.click(within(queue).getByRole('button', { name: /Sync now/ }));
    await waitFor(() => expect(screen.queryByTestId('offline-queue')).not.toBeInTheDocument());
    expect(punches).toEqual([expect.objectContaining({ direction: 'in', clientQueuedAt: expect.any(String), idempotencyKey: expect.any(String) })]);
  });
});

describe('offline replay outcomes', () => {
  it('retries what nobody answered, drops a refusal', () => {
    expect(sendOutcomeOf(new ApiError(0, 'NETWORK_ERROR', 'offline'))).toMatchObject({ kind: 'retry' });
    expect(sendOutcomeOf(new ApiError(503, 'UNAVAILABLE', 'busy'))).toMatchObject({ kind: 'retry' });
    expect(sendOutcomeOf(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'retry' });
    expect(sendOutcomeOf(new ApiError(403, 'FORBIDDEN', 'outside', undefined, { reason: 'OUTSIDE_GEOFENCE' }))).toEqual({ kind: 'refused', reason: 'OUTSIDE_GEOFENCE' });
    expect(sendOutcomeOf(new ApiError(422, 'VALIDATION_FAILED', 'bad'))).toEqual({ kind: 'refused', reason: 'VALIDATION_FAILED' });
  });

  it('4-P1-4 a duplicate counts as recorded only when it is of the punch\'s own direction; otherwise it stays queued with the server\'s message', () => {
    const dup = (direction?: string) => new ApiError(409, 'CONFLICT', 'You just punched; wait a moment before punching again.', undefined, { reason: 'DUPLICATE_PUNCH', ...(direction ? { direction } : {}) });
    expect(sendOutcomeOf(dup('in'), { direction: 'in' })).toEqual({ kind: 'sent' });
    expect(sendOutcomeOf(dup('in'), { direction: 'out' })).toEqual({ kind: 'retry', error: 'You just punched; wait a moment before punching again.' });
    // an API that does not say which direction it holds: never assumed to be this punch
    expect(sendOutcomeOf(dup(), { direction: 'out' })).toMatchObject({ kind: 'retry' });
    expect(sendOutcomeOf(dup('out'))).toMatchObject({ kind: 'retry' });
  });

  it('4-P1-4 replaying a queued in / out pair keeps the check-out when the server answers it with the check-in\'s duplicate (probe W2)', async () => {
    const store = createMemoryStore();
    setPunchQueueStore(store);
    await store.put({ key: 'k-in', userId: 'u1', orgId: ORG, direction: 'in', clientQueuedAt: '2026-09-27T04:00:00Z', attempts: 0, lastError: null });
    await store.put({ key: 'k-out', userId: 'u1', orgId: ORG, direction: 'out', clientQueuedAt: '2026-09-27T04:00:30Z', attempts: 0, lastError: null });
    mockGeolocation({ latitude: 23.5881, longitude: 58.383, accuracy: 12 });
    mockGet({ [`/orgs/${ORG}/me/punch/status`]: { data: status() } });
    // an older API: the check-out right after the check-in answered as the check-in's duplicate
    apiMock.post.mockImplementation((path: string, body: { direction?: string }) => {
      if (path.endsWith('/me/punch/preview')) return Promise.resolve({ data: preview() });
      if (path.endsWith('/me/punch')) {
        if (body.direction === 'out') return Promise.reject(new ApiError(409, 'CONFLICT', 'You just punched; wait a moment before punching again.', undefined, { reason: 'DUPLICATE_PUNCH', direction: 'in' }));
        return Promise.resolve({ data: { replayed: false, punch: { id: 'p1', punchedAt: '2026-09-27T04:30:00Z', direction: 'in', source: 'SELF_SERVICE', channel: 'web', verdict: 'allowed', deviceName: null, processingStatus: 'pending' }, verdict: preview().verdict, outOfWindow: false, flagged: false } });
      }
      return Promise.reject(new ApiError(404, 'NOT_FOUND', 'x'));
    });
    renderWithProviders(<CheckInPage />);
    const queue = await screen.findByTestId('offline-queue');
    await waitFor(() => expect(within(queue).getByTestId('offline-last-error')).toHaveTextContent('You just punched'));
    expect((await store.all()).map((p) => p.key)).toEqual(['k-out']);
  });
});

describe('offline queue per user (4-P0-3)', () => {
  const queued = (key: string, userId: string, orgId = ORG): QueuedPunch => ({ key, userId, orgId, direction: 'in', lat: 23.61, lng: 58.54, accuracy: 9, clientQueuedAt: '2026-09-27T03:00:00Z', attempts: 0, lastError: null });
  function punchApi(sent: unknown[]) {
    apiMock.post.mockImplementation((path: string, body: unknown) => {
      if (path.endsWith('/me/punch/preview')) return Promise.resolve({ data: preview() });
      if (path.endsWith('/me/punch')) { sent.push(body); return Promise.resolve({ data: { replayed: false, punch: { id: 'p1', punchedAt: '2026-09-27T04:30:00Z', direction: 'in', source: 'SELF_SERVICE', channel: 'web', verdict: 'allowed', deviceName: null, processingStatus: 'pending' }, verdict: preview().verdict, outOfWindow: false, flagged: false } }); }
      return Promise.reject(new ApiError(404, 'NOT_FOUND', 'x'));
    });
  }
  async function openCheckIn(store: PunchQueueStore) {
    setPunchQueueStore(store);
    mockGeolocation({ latitude: 23.5881, longitude: 58.383, accuracy: 12 });
    mockGet({ [`/orgs/${ORG}/me/punch/status`]: { data: status() } });
    const view = renderWithProviders(<CheckInPage />);
    await screen.findByTestId('verdict-banner');
    return view;
  }

  it('4-P0-3 a punch queued by user A is never replayed under user B\'s session (probe W1), nor shown to them', async () => {
    const store = createMemoryStore();
    await store.put(queued('user-a-key-1', 'user-a'));
    const sent: unknown[] = [];
    punchApi(sent);
    testState.userId = 'user-b';
    await openCheckIn(store);
    // give the automatic replay every chance to run
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
    expect(apiMock.post).not.toHaveBeenCalledWith(`/orgs/${ORG}/me/punch`, expect.objectContaining({ idempotencyKey: 'user-a-key-1' }));
    expect(screen.queryByTestId('offline-queue')).not.toBeInTheDocument();
    expect((await store.all()).map((p) => [p.key, p.userId])).toEqual([['user-a-key-1', 'user-a']]);
  });

  it('4-P0-3 signing out leaves the queue as it is; the next user never sends it, its owner does when they are back', async () => {
    const store = createMemoryStore();
    await store.put(queued('mine-1', 'u1'));
    const sent: Array<{ idempotencyKey?: string }> = [];
    punchApi(sent);
    // another person signs in on this browser: nothing of u1's is sent
    testState.userId = 'u2';
    const other = await openCheckIn(store);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
    other.unmount();
    expect((await store.all()).map((p) => p.key)).toEqual(['mine-1']);
    // u1 signs in again: their punch goes out with their own session
    testState.userId = 'u1';
    await openCheckIn(store);
    await waitFor(() => expect(sent.map((b) => b.idempotencyKey)).toEqual(['mine-1']));
    await waitFor(async () => expect(await store.all()).toEqual([]));
  });

  it('4-P0-3 punches saved before the queue knew its users are discarded once, with a notice, never sent', async () => {
    const warn = vi.spyOn(toast, 'warning');
    const store = createMemoryStore();
    await store.put({ key: 'legacy-1', orgId: ORG, direction: 'in', clientQueuedAt: '2026-09-27T03:00:00Z', attempts: 0, lastError: null } as unknown as QueuedPunch);
    const sent: unknown[] = [];
    punchApi(sent);
    await openCheckIn(store);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be tied to an account')));
    expect(sent).toEqual([]);
    expect(await store.all()).toEqual([]);
  });

  it('4-P0-3 the discard button removes only the signed-in user\'s punch', async () => {
    const store = createMemoryStore();
    await store.put(queued('mine-2', 'u1'));
    await store.put(queued('theirs-2', 'someone-else'));
    apiMock.post.mockImplementation((path: string) => (path.endsWith('/me/punch/preview') ? Promise.resolve({ data: preview() }) : Promise.reject(new ApiError(0, 'NETWORK_ERROR', 'offline'))));
    await openCheckIn(store);
    const queue = await screen.findByTestId('offline-queue');
    expect(within(queue).getByText('Saved on this device (1)')).toBeInTheDocument();
    fireEvent.click(within(queue).getByRole('button', { name: /Discard/ }));
    await waitFor(() => expect(screen.queryByTestId('offline-queue')).not.toBeInTheDocument());
    expect((await store.all()).map((p) => p.key)).toEqual(['theirs-2']);
  });
});

describe('accuracy warning (4-P2-16)', () => {
  it('4-P2-16 warns when the location is less precise than 50 m, even inside the zone (probe W3)', async () => {
    mockGeolocation({ latitude: 23.5881, longitude: 58.383, accuracy: 90 });
    mockGet({ [`/orgs/${ORG}/me/punch/status`]: { data: status() } });
    apiMock.post.mockResolvedValue({ data: preview() });
    renderWithProviders(<CheckInPage />);
    expect(await screen.findByTestId('accuracy-warning')).toHaveTextContent('±90 m');
    // the verdict arrives with the preview (a request after the fix), the warning straight from the fix: wait for both
    expect(await screen.findByTestId('verdict-banner')).toHaveTextContent('Inside HQ');
  });
  it('4-P2-16 says nothing for a precise fix', async () => {
    mockGeolocation({ latitude: 23.5881, longitude: 58.383, accuracy: 20 });
    mockGet({ [`/orgs/${ORG}/me/punch/status`]: { data: status() } });
    apiMock.post.mockResolvedValue({ data: preview() });
    renderWithProviders(<CheckInPage />);
    await screen.findByTestId('verdict-banner');
    expect(screen.queryByTestId('accuracy-warning')).not.toBeInTheDocument();
  });
});

describe('NoteDialog', () => {
  it('files a reason for a day', async () => {
    apiMock.post.mockResolvedValue({ data: note() });
    const onOpenChange = vi.fn();
    renderWithProviders(<NoteDialog open onOpenChange={onOpenChange} date="2026-09-20" defaultCategory="absence_reason" />);
    fireEvent.change(screen.getByLabelText(/Details/), { target: { value: 'Doctor appointment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/attendance/notes`, { date: '2026-09-20', category: 'absence_reason', note: 'Doctor appointment' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('refuses a reason too short to act on', () => {
    renderWithProviders(<NoteDialog open onOpenChange={vi.fn()} date="2026-09-20" />);
    fireEvent.change(screen.getByLabelText(/Details/), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Write at least 3 characters.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('shows the reviewer\'s question and sends the answer as an edit', async () => {
    apiMock.patch.mockResolvedValue({ data: note({ status: 'pending' }) });
    renderWithProviders(<NoteDialog open onOpenChange={vi.fn()} note={note({ status: 'info_requested', infoRequestMessage: 'Which client?' })} />);
    expect(screen.getByTestId('note-question')).toHaveTextContent('Your manager asked: Which client?');
    fireEvent.change(screen.getByLabelText(/Details/), { target: { value: 'At Omantel HQ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith(`/orgs/${ORG}/me/attendance/notes/n1`, { category: 'client_visit', note: 'At Omantel HQ' }));
  });
});

describe('MyRequestsPage', () => {
  const reg = (over: Partial<RegularisationDto> = {}): RegularisationDto => ({
    id: 'r1', employeeId: EMP, attendanceDate: '2026-09-22', type: 'missed_punch', proposedInAt: '2026-09-22T04:00:00Z', proposedOutAt: null, reason: 'Forgot at the gate', status: 'pending',
    approvalRequestId: 'req-2', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1, appliedCorrectionId: null, appliedAt: null, decidedByName: null, decidedAt: null, decisionNote: null,
    createdAt: '2026-09-22T06:00:00Z', updatedAt: '2026-09-22T06:00:00Z', ...over,
  });

  it('lists the reasons with their decisions and the pay effect of a rejection', async () => {
    mockGet({ [`/orgs/${ORG}/me/attendance/notes`]: { data: [note({ status: 'info_requested', infoRequestMessage: 'Which client?' }), note({ id: 'n2', attendanceDate: '2026-09-10', status: 'rejected', reviewedByName: 'Mansoor', reviewReason: 'No proof', payEffectDays: 1, lossOfPay: false, deductedLeaveTypeName: 'Annual Leave' })] } });
    renderWithProviders(<MyRequestsPage />);
    expect(await screen.findByText('More information needed')).toBeInTheDocument();
    expect(screen.getByText('Your manager asked: Which client?')).toBeInTheDocument();
    expect(screen.getByText('1 day charged to Annual Leave')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Answer/ })).toBeInTheDocument();
  });

  it('opens the employee\'s own selfie photo through the API, only when asked', async () => {
    const selfie = { id: 's1', employeeId: EMP, employeeName: null, employeeNumber: null, punchedAt: '2026-09-27T04:02:00Z', direction: 'in', latitude: 23.6, longitude: 58.4, accuracyM: 20, verdict: 'allowed', status: 'pending', reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewReason: null, rawTransactionId: null, createdAt: '2026-09-27T04:02:00Z', canViewPhoto: true };
    mockGet({ [`/orgs/${ORG}/me/selfie-checkins`]: { data: [selfie] }, [`/orgs/${ORG}/me/selfie-checkins/s1/photo`]: { data: { url: 'https://signed.example/own.jpg', expiresInSeconds: 60 } } });
    renderWithProviders(<MyRequestsPage />, { route: '/my/requests?tab=selfies' });
    const row = await screen.findByTestId('selfie-row');
    expect(apiMock.get).not.toHaveBeenCalledWith(`/orgs/${ORG}/me/selfie-checkins/s1/photo`);
    fireEvent.click(within(row).getByRole('button', { name: /View photo/ }));
    expect(await screen.findByRole('img', { name: 'Your selfie' })).toHaveAttribute('src', 'https://signed.example/own.jpg');
    expect(screen.getByText('The link works for one minute and opening it is recorded.')).toBeInTheDocument();
  });

  it('withdraws a pending regularisation', async () => {
    mockGet({ [`/orgs/${ORG}/me/regularisations`]: { data: [reg()] } });
    apiMock.post.mockResolvedValue({ data: reg({ status: 'cancelled' }) });
    renderWithProviders(<MyRequestsPage />, { route: '/my/requests?tab=regularisations' });
    fireEvent.click(await screen.findByRole('button', { name: /Withdraw/ }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Withdraw/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/regularisations/r1/cancel`, {}));
  });
});

describe('MyShiftPage', () => {
  it('shows today, the coming days with their source, and offers a swap on a working day', async () => {
    const shift = { id: 's1', code: 'D', name: 'Day', type: 'FIXED' as const, startTime: '08:00:00', endTime: '17:00:00', requiredMinutes: 480, graceInMinutes: 10, crossesMidnight: false, color: '#175cd3', breakMinutes: 60 };
    const day = (date: string, over = {}) => ({ date, shift, source: 'ASSIGNMENT' as const, isOff: false, holidayName: null, onLeave: false, swap: null, ...over });
    mockGet({
      [`/orgs/${ORG}/me/shift`]: { data: { date: '2026-09-27', timezone: 'Asia/Muscat', today: day('2026-09-27'), upcoming: [day('2026-09-28'), day('2026-09-29', { isOff: true, shift: null, source: 'NONE' }), day('2026-09-30', { swap: { id: 'w1', status: 'pending', withEmployeeName: 'Sara' } })], history: [{ id: 'a1', targetType: 'BRANCH', shiftName: 'Day', patternName: null, effectiveFrom: '2026-01-01', effectiveTo: null, isSwap: false }] } },
      [`/orgs/${ORG}/me/shift-swaps`]: { data: [] },
      [`/orgs/${ORG}/me/shift-swaps/candidates`]: { data: [{ employeeId: 'e2', displayName: 'Sara Nasser', employeeNumber: 'A-002', shift: { ...shift, id: 's2', name: 'Night', startTime: '20:00:00', endTime: '05:00:00' }, isOff: false, eligible: true }] },
    });
    apiMock.post.mockResolvedValue({ data: {} });
    renderWithProviders(<MyShiftPage />);
    expect(await screen.findByText('Swap pending with Sara')).toBeInTheDocument();
    expect(screen.getAllByText('Day 08:00–17:00').length).toBeGreaterThan(0);
    expect(screen.getByText('Day off')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Request a swap/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('radio', { name: /Sara Nasser/ }));
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Family event' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/shift-swaps`, { date: '2026-09-27', withEmployeeId: 'e2', reason: 'Family event' }));
  });
});

describe('portal home (Prompt 4)', () => {
  it('shows the punch state and what is waiting on others', () => {
    const overview = { date: '2026-09-27', timezone: 'Asia/Muscat', punch: { lastDirection: 'in' as const, lastPunchAt: '2026-09-27T04:05:00Z', punchesToday: 1, canCheckIn: false, canCheckOut: true, checkInEnabled: true }, infoRequestedNotes: 1, pendingNotes: 2, pendingRegularisations: 0, pendingSwaps: 1, reasonsRequired: 3 };
    renderWithProviders(<><PendingSelfItems overview={overview as never} /><HomePunchCard overview={overview as never} /></>);
    expect(screen.getByTestId('home-punch')).toHaveTextContent('Checked in at 08:05');
    expect(screen.getByRole('link', { name: /Check out/ })).toHaveAttribute('href', '/my/checkin');
    const pending = screen.getByTestId('home-pending');
    expect(pending).toHaveTextContent('1 reason needs more information');
    expect(pending).toHaveTextContent('2 reasons awaiting review');
    expect(pending).toHaveTextContent('1 shift swap pending');
    expect(pending).not.toHaveTextContent('regularisation');
    // the organisation requires a reason for these days and none was given: the badge leads to the last-30-days table
    expect(screen.getByRole('link', { name: '3 days need a reason' })).toHaveAttribute('href', '/my/attendance?tab=recent');
  });

  it('stays hidden when self-service check-in is off (or the API predates it)', () => {
    renderWithProviders(<HomePunchCard overview={{ date: '2026-09-27', timezone: 'Asia/Muscat' } as never} />);
    expect(screen.queryByTestId('home-punch')).not.toBeInTheDocument();
  });
});

describe('MyAttendancePage — last 30 days (Prompt 4)', () => {
  const today = todayIso('Asia/Muscat');
  const ago = (n: number) => DateTime.fromISO(today).minus({ days: n }).toISODate() ?? today;
  const rec = (id: string, date: string, status: string, flags: string[] = []): SelfDayDto => ({
    id, employeeId: EMP, employeeNumber: 'MG-1012', employeeName: 'Priya Sharma', attendanceDate: date, branchId: 'b1', branchName: 'Head Office', departmentId: null, departmentName: null,
    shiftId: 's1', shiftName: 'Office 08:00–17:00', timezone: 'Asia/Muscat', expectedStartAt: null, expectedEndAt: null, scheduledMinutes: 480, firstInAt: null, lastOutAt: null, workedMinutes: 0,
    breakMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null, status, flags, punchCount: 0, hasCorrection: false, calculationVersion: 1,
    computedAt: `${date}T10:00:00Z`, lockedAt: null, lopDays: 0, unexcused: false,
  } as SelfDayDto);
  const totals = { present: 1, absent: 2, leave: 0, holiday: 0, weeklyOff: 0, halfDay: 0, late: 1, missingPunch: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, workingDays: 3, attendanceRate: 0.33 };

  it('lists each day with its reason and marks the days the organisation requires a reason for', async () => {
    // only absences need a reason in this organisation; a late day still invites one, without the "required" mark
    testState.settings = { attendance: { notes: { requireReasonForAbsent: true, requireReasonForLate: false } } };
    const days = [rec('r3', ago(3), 'ABSENT'), rec('r2', ago(2), 'PRESENT', ['LATE']), rec('r1', ago(1), 'ABSENT')];
    mockGet({
      [`/orgs/${ORG}/me/attendance`]: (q: Record<string, unknown> | undefined) => ({ data: { month: String(q?.month), days: days.filter((d) => d.attendanceDate.startsWith(String(q?.month))), totals, leaveByDate: {}, holidaysByDate: {} } }),
      [`/orgs/${ORG}/me/attendance/notes`]: { data: [note({ id: 'n1', attendanceDate: ago(1), status: 'pending' })] },
    });
    renderWithProviders(<MyAttendancePage />, { route: '/my/attendance?tab=recent' });
    const rows = await screen.findAllByTestId('recent-day');
    expect(rows).toHaveLength(3);
    // newest first: yesterday carries its pending reason (editable), not a "required" mark
    expect(within(rows[0]!).getByText('Awaiting review')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(rows[0]!).queryByTestId('reason-required')).not.toBeInTheDocument();
    expect(within(rows[1]!).queryByTestId('reason-required')).not.toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: /Add a reason/ })).toBeInTheDocument();
    expect(within(rows[2]!).getByTestId('reason-required')).toHaveTextContent('Reason required');

    // "Add a reason" opens the dialog on that day with the absence category suggested
    apiMock.post.mockResolvedValue({ data: note({ id: 'n3', attendanceDate: ago(3) }) });
    fireEvent.click(within(rows[2]!).getByRole('button', { name: /Add a reason/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Details/), { target: { value: 'Hospital visit' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/attendance/notes`, { date: ago(3), category: 'absence_reason', note: 'Hospital visit' }));
  });

  it('marks nothing as required when the organisation requires no reason', async () => {
    const days = [rec('r1', ago(1), 'ABSENT')];
    mockGet({
      [`/orgs/${ORG}/me/attendance`]: (q: Record<string, unknown> | undefined) => ({ data: { month: String(q?.month), days: days.filter((d) => d.attendanceDate.startsWith(String(q?.month))), totals, leaveByDate: {}, holidaysByDate: {} } }),
      [`/orgs/${ORG}/me/attendance/notes`]: { data: [] },
    });
    renderWithProviders(<MyAttendancePage />, { route: '/my/attendance?tab=recent' });
    const rows = await screen.findAllByTestId('recent-day');
    expect(rows).toHaveLength(1);
    expect(screen.queryByTestId('reason-required')).not.toBeInTheDocument();
    // an absence still invites a reason
    expect(within(rows[0]!).getByRole('button', { name: /Add a reason/ })).toBeInTheDocument();
  });
});

describe('SelfStats', () => {
  it('shows attendance against the target, punctuality and the hints', async () => {
    const w = (days: number, onTime: number) => ({ from: '2026-09-01', to: '2026-09-27', days, onTimeDays: onTime, lateDays: days - onTime, avgArrivalDeltaMinutes: 3, totalDelayMinutes: 40, avgDelayMinutes: 20 });
    const stats: SelfStatsDto = {
      range: '30d', from: '2026-08-29', to: '2026-09-27', workingDays: 20, presentDays: 16, halfDays: 0, absentDays: 2, leaveDays: 2, lateDays: 2, missingCheckouts: 1, workedDays: 16, workedMinutes: 7200,
      avgHoursPerDay: 7.5, attendancePct: 88.9, targets: { attendancePct: 90, fullDayHours: 8 },
      hints: [{ kind: 'low_attendance', value: 88.9, target: 90 }, { kind: 'missing_checkouts', value: 1, target: null }],
      punctuality: { last7Days: w(5, 5), thisMonth: w(18, 16), lastMonth: w(21, 19) },
    };
    mockGet({ [`/orgs/${ORG}/me/stats`]: { data: stats } });
    renderWithProviders(<SelfStats />);
    expect(await screen.findByText('88.9%')).toBeInTheDocument();
    expect(screen.getByText('Target 90% · leave excluded')).toBeInTheDocument();
    const hints = screen.getByTestId('stats-hints');
    expect(hints).toHaveTextContent('Your attendance (88.9%) is below the 90% target.');
    expect(hints).toHaveTextContent('You forgot to check out on 1 day.');
    expect(screen.getAllByTestId('punctuality-window')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'This year' }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(`/orgs/${ORG}/me/stats`, { range: 'year' }));
  });
});
