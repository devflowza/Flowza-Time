import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { MeetingDetailDto, MeetingDto, MeetingRoomDto } from '@flowza/contracts';
import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import './i18n';
import MeetingsPage from './pages/meetings-page';
import { meetingDay, periodDays, weekStart, zonedInstant } from './model';
import { N_F2, locationRoutes } from '@/features/scheduling/test-locations';

const BR1 = 'b1000000-0000-4000-8000-000000000001';
const ROOM = 'a0000000-0000-4000-8000-000000000001';
const E1 = 'e1000000-0000-4000-8000-000000000001';
const E2 = 'e2000000-0000-4000-8000-000000000002';
const D1 = 'd1000000-0000-4000-8000-000000000001';
const T = '2026-10-01T00:00:00Z';
// the room's branch runs on Riyadh time (UTC+3) while the organisation is in Muscat (UTC+4): times show in the room's zone
const BRANCHES = [{ id: BR1, organizationId: 'org-1', code: 'B1', name: 'Branch 1', nameAr: null, countryCode: 'OM', city: null, address: {}, timezone: 'Asia/Riyadh', latitude: null, longitude: null, geofenceRadiusM: null, status: 'active', createdAt: T, updatedAt: T }];
const room = (over: Partial<MeetingRoomDto> = {}): MeetingRoomDto => ({
  id: ROOM, branchId: BR1, branchName: 'Branch 1', locationId: 'c0000000-0000-4000-8000-0000000000d2', locationName: 'HQ Tower › Floor 3 › Boardroom', name: 'Boardroom', capacity: 10, restricted: true,
  allowedDepartmentIds: [], allowedEmployeeIds: [], status: 'active', readers: [{ id: 'dev-1', code: 'ACC-1', name: 'Boardroom reader', connectionStatus: 'online' }], meetingsToday: 2, ...over,
});
const meeting = (id: string, over: Partial<MeetingDto> = {}): MeetingDto => ({
  id, branchId: BR1, roomId: ROOM, roomName: 'Boardroom', title: `Meeting ${id}`, description: null, startsAt: '2026-10-15T06:00:00Z', endsAt: '2026-10-15T07:00:00Z', lateAfterMinutes: 5,
  organizerEmployeeId: 'e9', organizerName: 'Salim Al Harthy', status: 'scheduled', phase: 'over', invitedCount: 4, attendedCount: 3, lateCount: 1, absentCount: 1, walkInCount: 2, ...over,
});
const M1 = meeting('m1', { title: 'Budget review' });
const M2 = meeting('m2', { title: 'Weekly sync', startsAt: '2026-10-15T10:00:00Z', endsAt: '2026-10-15T10:30:00Z', phase: 'upcoming', invitedCount: 5, attendedCount: 0, lateCount: 0, absentCount: 0, walkInCount: 0 });
const DETAIL: MeetingDetailDto = {
  ...M1,
  attendees: [
    { employeeId: 'e1', employeeName: 'Aisha Al Balushi', employeeNumber: 'E-001', departmentName: 'Finance', required: true, status: 'ON_TIME', enteredAt: '2026-10-15T05:58:00Z', lateMinutes: 0, entries: 1 },
    { employeeId: 'e2', employeeName: 'Badr Al Said', employeeNumber: 'E-002', departmentName: 'Finance', required: true, status: 'LATE', enteredAt: '2026-10-15T06:12:00Z', lateMinutes: 12, entries: 2 },
    { employeeId: 'e3', employeeName: 'Fatma Al Lawati', employeeNumber: 'E-003', departmentName: 'Sales', required: true, status: 'ABSENT', enteredAt: null, lateMinutes: 0, entries: 0 },
    { employeeId: 'e4', employeeName: 'Hamed Al Rawahi', employeeNumber: 'E-004', departmentName: null, required: false, status: 'ON_TIME', enteredAt: '2026-10-15T06:01:00Z', lateMinutes: 0, entries: 1 },
  ],
  walkIns: [
    { employeeId: 'e7', employeeName: 'Khalid Al Hinai', deviceEmployeeId: '1007', enteredAt: '2026-10-15T06:20:00Z', unauthorized: true },
    { employeeId: null, employeeName: null, deviceEmployeeId: '77', enteredAt: '2026-10-15T06:25:00Z', unauthorized: false },
  ],
  noReader: false,
};
const EMPLOYEES = [{ id: E1, displayName: 'Aisha Al Balushi', employeeNumber: 'E-001' }, { id: E2, displayName: 'Badr Al Said', employeeNumber: 'E-002' }];

const meetingsCalls = () => apiMock.get.mock.calls.filter(([p]) => p === '/orgs/org-1/meetings') as Array<[string, Record<string, unknown>]>;

function routes(over: Record<string, unknown> = {}) {
  mockGet({
    '/orgs/org-1/meeting-rooms': { data: [room()] },
    '/orgs/org-1/meetings': { data: [M1, M2] },
    '/orgs/org-1/meetings/m1': { data: DETAIL },
    '/orgs/org-1/branches': page(BRANCHES),
    '/orgs/org-1/employees': page(EMPLOYEES),
    '/orgs/org-1/departments': page([{ id: D1, code: 'FIN', name: 'Finance', branchName: null, status: 'active' }]),
    ...locationRoutes(),
    ...over,
  });
}

describe('meetings page — attendance from the room readers (docs/time-away.md §4)', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    testState.timezone = 'Asia/Muscat';
    testState.disabledModules = new Set();
    routes();
  });

  it('lists the day\'s meetings with their window in the room\'s zone, phase and attendance counts', async () => {
    renderWithProviders(<MeetingsPage />, { route: '/meetings?date=2026-10-15' });
    const counts = await screen.findByTestId('meeting-counts-m1');
    expect(counts).toHaveTextContent('Attended 3 of 4 · late 1 · absent 1 · walk-ins 2');
    // an upcoming meeting has nothing measured yet: only its invitations
    expect(screen.getByTestId('meeting-counts-m2')).toHaveTextContent('Invited: 5');
    const card = screen.getByTestId('meeting-m1');
    await waitFor(() => expect(card).toHaveTextContent('09:00–10:00')); // 06:00Z in Riyadh (the branch), not Muscat
    expect(within(card).getByText('Over')).toBeInTheDocument();
    expect(within(screen.getByTestId('meeting-m2')).getByText('Upcoming')).toBeInTheDocument();
    expect(card).toHaveTextContent('Organiser: Salim Al Harthy');
    expect(meetingsCalls()[0]?.[1]).toMatchObject({ from: '2026-10-15', to: '2026-10-15' });
  });

  it('opens a meeting: each invitee\'s status, entry and lateness, and the walk-ins flagged unauthorised', async () => {
    renderWithProviders(<MeetingsPage />, { route: '/meetings?date=2026-10-15' });
    fireEvent.click(await screen.findByTestId('meeting-m1'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('heading', { name: 'Budget review' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('meeting=m1');
    const onTime = within(dialog).getByTestId('attendee-e1');
    expect(within(onTime).getByText('On time')).toBeInTheDocument();
    expect(onTime).toHaveTextContent('08:58');
    const late = within(dialog).getByTestId('attendee-e2');
    expect(within(late).getByText('Late')).toBeInTheDocument();
    expect(late).toHaveTextContent('12m late');
    expect(within(within(dialog).getByTestId('attendee-e3')).getByText('Absent')).toBeInTheDocument();
    expect(within(within(dialog).getByTestId('attendee-e4')).getByText('Optional')).toBeInTheDocument();
    expect(within(dialog).getByTestId('meeting-stat-absent')).toHaveTextContent('1');
    const walkIns = within(dialog).getByTestId('meeting-walk-ins');
    expect(within(walkIns).getAllByText('Unauthorised')).toHaveLength(1);
    expect(walkIns).toHaveTextContent('Khalid Al Hinai');
    expect(walkIns).toHaveTextContent('Unknown card 77');
    expect(within(dialog).queryByTestId('meeting-no-reader')).not.toBeInTheDocument();
  });

  it('warns when the room has no reader, and cancels a meeting for meeting.manage holders', async () => {
    routes({ '/orgs/org-1/meetings/m1': { data: { ...DETAIL, phase: 'upcoming', noReader: true } } });
    apiMock.post.mockResolvedValue({ data: { ...DETAIL, status: 'cancelled' } });
    renderWithProviders(<MeetingsPage />, { route: '/meetings?date=2026-10-15&meeting=m1' });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('meeting-no-reader')).toHaveTextContent('no access reader');
    fireEvent.click(within(dialog).getByRole('button', { name: /Cancel meeting/ }));
    const confirm = await screen.findByRole('dialog', { name: /Cancel "Budget review"/ });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel meeting' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/meetings/m1/cancel', {}));
  });

  it('a meeting.view holder sees no cancel action and no access log', async () => {
    grant('meeting.view');
    renderWithProviders(<MeetingsPage />, { route: '/meetings?date=2026-10-15&meeting=m1' });
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('attendee-e1');
    expect(within(dialog).queryByRole('button', { name: /Cancel meeting/ })).not.toBeInTheDocument();
    // (the page behind the open dialog is aria-hidden)
    expect(screen.getByRole('tab', { name: 'Rooms', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Access log', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New meeting', hidden: true })).not.toBeInTheDocument();
  });

  it('the week view asks for the whole week and keeps the meetings whose local day is in it', async () => {
    const lateSaturday = meeting('m3', { title: 'After hours', startsAt: '2026-10-17T21:30:00Z', endsAt: '2026-10-17T22:00:00Z' }); // Sunday 00:30 in Riyadh
    routes({ '/orgs/org-1/meetings': { data: [M1, lateSaturday] } });
    renderWithProviders(<MeetingsPage />, { route: '/meetings?view=week&date=2026-10-15' });
    await screen.findByTestId('meeting-m1');
    await waitFor(() => expect(screen.queryByTestId('meeting-m3')).not.toBeInTheDocument());
    expect(meetingsCalls()[0]?.[1]).toMatchObject({ from: '2026-10-11', to: '2026-10-17' });
    expect(screen.getByRole('heading', { name: /Thursday 15 Oct/ })).toBeInTheDocument();
  });

  it('books a meeting: the window in the room\'s local time is sent as instants, with each invitee required or not', async () => {
    apiMock.post.mockResolvedValue({ data: { ...DETAIL, id: 'm9' } });
    renderWithProviders(<MeetingsPage />, { route: '/meetings?date=2026-10-15' });
    await screen.findByTestId('meeting-m1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'New meeting' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }));
    const dialog = await screen.findByRole('dialog', { name: 'New meeting' });
    // the only room is chosen already; its zone is the branch's
    expect(within(dialog).getByRole('combobox', { name: /^Room/ })).toHaveTextContent('Boardroom');
    await waitFor(() => expect(dialog).toHaveTextContent('Asia/Riyadh'));
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'Quarterly plan' } });
    fireEvent.change(within(dialog).getByLabelText(/^Date/), { target: { value: '2026-10-20' } });
    fireEvent.change(within(dialog).getByLabelText(/^Starts/), { target: { value: '09:30' } });
    fireEvent.change(within(dialog).getByLabelText(/^Ends/), { target: { value: '10:15' } });
    fireEvent.click(within(dialog).getByRole('combobox', { name: /^Invitees/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Badr Al Said/ }));
    const list = within(dialog).getByTestId('invitee-list');
    fireEvent.click(within(list).getByRole('checkbox', { name: 'Required' }));
    fireEvent.click(within(dialog).getByTestId('meeting-save'));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/meetings', {
      roomId: ROOM, title: 'Quarterly plan', startsAt: '2026-10-20T06:30:00Z', endsAt: '2026-10-20T07:15:00Z', lateAfterMinutes: 5, invitees: [{ employeeId: E2, required: false }],
    }));
    // the new meeting opens
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('meeting=m9'));
  });

  it('refuses an end before the start and more invitees than the room holds', async () => {
    routes({ '/orgs/org-1/meeting-rooms': { data: [room({ capacity: 1 })] } });
    renderWithProviders(<MeetingsPage />, { route: '/meetings?date=2026-10-15' });
    await screen.findByTestId('meeting-m1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'New meeting' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }));
    const dialog = await screen.findByRole('dialog', { name: 'New meeting' });
    fireEvent.change(within(dialog).getByLabelText(/^Starts/), { target: { value: '11:00' } });
    fireEvent.change(within(dialog).getByLabelText(/^Ends/), { target: { value: '10:00' } });
    expect(within(dialog).getByText('The meeting must end after it starts.')).toBeInTheDocument();
    for (const name of [/Aisha Al Balushi/, /Badr Al Said/]) {
      fireEvent.click(within(dialog).getByRole('combobox', { name: /^Invitees/ }));
      fireEvent.click(await screen.findByRole('option', { name }));
    }
    expect(within(dialog).getByText('The room holds 1 people; 2 are invited.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId('meeting-save'));
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('lists the rooms with their place, access rule and readers', async () => {
    routes({ '/orgs/org-1/meeting-rooms': { data: [room(), room({ id: 'r2', name: 'Huddle', restricted: false, readers: [], capacity: null, meetingsToday: 0 })] } });
    renderWithProviders(<MeetingsPage />, { route: '/meetings?tab=rooms' });
    expect((await screen.findAllByText('Boardroom')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('HQ Tower › Floor 3 › Boardroom').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Restricted').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Boardroom reader').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No reader').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No limit').length).toBeGreaterThan(0);
  });

  it('creates a room from a place of the tree, restricted to a department', async () => {
    apiMock.post.mockResolvedValue({ data: room({ id: 'r9' }) });
    renderWithProviders(<MeetingsPage />, { route: '/meetings?tab=rooms' });
    await screen.findAllByText('Boardroom');
    fireEvent.click(screen.getByRole('button', { name: 'New room' }));
    const dialog = await screen.findByRole('dialog', { name: 'New room' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: /^Location/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Floor 2/ }));
    // the place's name is the room's name until it is typed over
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('Floor 2');
    fireEvent.change(within(dialog).getByLabelText(/^Capacity/), { target: { value: '8' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Restricted access' }));
    fireEvent.click(within(dialog).getByRole('combobox', { name: /^Allowed departments/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Finance/ }));
    fireEvent.click(within(dialog).getByTestId('room-save'));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/meeting-rooms', { locationId: N_F2, name: 'Floor 2', capacity: 8, restricted: true, allowedDepartmentIds: [D1], allowedEmployeeIds: [] }));
  });

  it('editing a room sends only the field that changed (PATCH, nothing reset by omission)', async () => {
    apiMock.patch.mockResolvedValue({ data: room({ capacity: 12 }) });
    renderWithProviders(<MeetingsPage />, { route: '/meetings?tab=rooms' });
    const cells = await screen.findAllByText('Boardroom');
    fireEvent.click(cells.map((c) => c.closest('tr')).find((tr): tr is HTMLTableRowElement => !!tr)!);
    const dialog = await screen.findByRole('dialog', { name: 'Edit Boardroom' });
    expect(within(dialog).getByText('Branch 1 › HQ Tower › Floor 3 › Boardroom')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^Capacity/), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByTestId('room-save'));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith(`/orgs/org-1/meeting-rooms/${ROOM}`, { capacity: 12 }));
  });

  it('the access log asks for unauthorised entries only when filtered', async () => {
    routes({
      '/orgs/org-1/access-events': page([{ id: 'a1', occurredAt: '2026-10-15T06:20:00Z', roomId: ROOM, roomName: 'Boardroom', deviceId: 'dev-1', deviceName: 'Boardroom reader', employeeId: 'e7', employeeName: 'Khalid Al Hinai', deviceEmployeeId: '1007', unauthorized: true, meetingId: 'm1', meetingTitle: 'Budget review' }]),
    });
    renderWithProviders(<MeetingsPage />, { route: '/meetings?tab=access&from=2026-10-10&to=2026-10-15' });
    expect((await screen.findAllByText('Khalid Al Hinai')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unauthorised').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('switch', { name: 'Unauthorised only' }));
    await waitFor(() => expect(apiMock.get).toHaveBeenLastCalledWith('/orgs/org-1/access-events', expect.objectContaining({ from: '2026-10-10', to: '2026-10-15', unauthorizedOnly: 'true', page: 1 })));
  });
});

describe('meetings model', () => {
  it('starts the week on the organisation\'s first day', () => {
    expect(weekStart('2026-10-15', 0)).toBe('2026-10-11'); // Sunday
    expect(weekStart('2026-10-15', 6)).toBe('2026-10-10'); // Saturday
    expect(weekStart('2026-10-15', 1)).toBe('2026-10-12'); // Monday
    expect(periodDays('week', '2026-10-15', 0)).toHaveLength(7);
  });
  it('reads a wall-clock time in the room\'s zone', () => {
    expect(zonedInstant('2026-10-20', '09:30', 'Asia/Muscat')).toBe('2026-10-20T05:30:00Z');
    expect(zonedInstant('2026-10-20', '', 'Asia/Muscat')).toBeNull();
    expect(meetingDay({ startsAt: '2026-10-17T21:30:00Z' }, 'Asia/Riyadh')).toBe('2026-10-18');
  });
});
