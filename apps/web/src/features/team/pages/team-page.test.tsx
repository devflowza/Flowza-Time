import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AttendanceDailyRecordDto, EmployeeDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { registerNamespace } from '@/lib/i18n-namespace';
import enApprovals from '@/locales/en/approvals.json';
import arApprovals from '@/locales/ar/approvals.json';
import enLeave from '@/locales/en/leave.json';
import arLeave from '@/locales/ar/leave.json';
import enCorrections from '@/locales/en/corrections.json';
import arCorrections from '@/locales/ar/corrections.json';
import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { approvalRequest, leaveContext } from '@/features/approvals/test-fixtures';
import { reviewNote, teamLeave, teamMember, teamSummary } from '../test-fixtures';
import TeamPage from './team-page';

registerNamespace('approvals', enApprovals, arApprovals);
registerNamespace('leave', enLeave, arLeave);
registerNamespace('corrections', enCorrections, arCorrections);

const MANAGER_KEYS = ['dashboard.view', 'employee.view_team', 'attendance.view_team', 'leave.view_team', 'approval.delegate'] as const;

const report = (id: string, name: string, managerEmployeeId: string | null, secondaryManagerEmployeeId: string | null): EmployeeDto => ({
  id, organizationId: 'org-1', employeeNumber: id.toUpperCase(), firstName: name, middleName: null, lastName: 'X', displayName: name, displayNameAr: null, photoPath: null, photoUrl: null, gender: 'unspecified', dateOfBirth: null, nationalityCode: null,
  email: null, phone: null, joiningDate: '2024-02-01', exitDate: null, employmentStatus: 'active', employmentType: 'full_time', branchId: 'b1', branchName: 'Muscat', departmentId: null, departmentName: 'IT', designationId: null, designationName: 'Engineer',
  managerEmployeeId, managerName: null, secondaryManagerEmployeeId, secondaryManagerName: null, userId: null, deviceUserId: '1', cardNumber: null, fingerprintEnrolled: false, faceEnrolled: false, weeklyOffDays: null, customFields: {},
  deviceSyncSummary: { total: 0, inSync: 0, pending: 0, failed: 0, offline: 0 }, deletedAt: null, createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z',
} as EmployeeDto);

const daily = (over: Partial<AttendanceDailyRecordDto> = {}): AttendanceDailyRecordDto => ({
  id: 'r5', employeeId: 'e5', attendanceDate: '2026-09-01', branchId: 'b1', departmentId: null, shiftId: null, timezone: 'Asia/Muscat', expectedStartAt: null, expectedEndAt: null, scheduledMinutes: 480,
  firstInAt: '2026-09-01T04:00:00Z', lastOutAt: '2026-09-01T12:00:00Z', workedMinutes: 480, breakMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null,
  status: 'PRESENT', flags: [], punchCount: 2, hasCorrection: false, calculationVersion: 1, computedAt: '2026-09-01T13:00:00Z', lockedAt: null, lopDays: 0, ...over,
} as AttendanceDailyRecordDto);

const recordDetail = { ...daily(), employeeName: 'Salma', employeeNumber: 'E005', ruleSetId: null, shiftAssignmentId: null, engineVersion: '1', trace: null, events: [], history: [], corrections: [], marks: [] };

function mockTeam(over: Record<string, unknown> = {}) {
  mockGet({
    '/orgs/org-1/team/summary': { data: teamSummary([teamMember()]) },
    '/orgs/org-1/team/pending-counts': { data: { approvals: 0, notes: 0, total: 0 } },
    '/orgs/org-1/branches': page([]),
    ...over,
  });
}

describe('TeamPage', () => {
  beforeEach(() => {
    resetApiMock();
    testState.orgId = 'org-1';
    testState.employeeId = 'e4';
    testState.teamSize = 2;
    grant(...MANAGER_KEYS);
  });

  it('tells a member without direct reports that the page is for managers', () => {
    testState.teamSize = 0;
    renderWithProviders(<TeamPage />, { route: '/team' });
    expect(screen.getByText('You have no direct reports')).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  describe('Today', () => {
    it('shows the totals and one card per report: status, in / out, live state, worked so far, leave, pending items', async () => {
      mockTeam({ '/orgs/org-1/team/summary': { data: teamSummary([
        teamMember({ employeeId: 'e5', employeeName: 'Salma', status: 'late', lateMinutes: 17, pendingItems: 2 }),
        teamMember({ employeeId: 'e6', employeeName: 'Yousuf', status: 'on_leave', liveState: 'NONE', firstInAt: null, workedMinutes: 0, workedIsLive: false, recordId: null, leave: { leaveTypeName: 'Sick Leave', leaveTypeCode: 'SL', color: '#dc2626', isHalfDay: false, halfDayPart: null, status: 'APPROVED' }, relation: 'secondary' }),
        teamMember({ employeeId: 'e7', employeeName: 'Huda', status: 'absent', liveState: 'NONE', firstInAt: null, workedMinutes: 0, workedIsLive: false }),
      ]) } });
      renderWithProviders(<TeamPage />, { route: '/team' });
      const cards = await screen.findAllByTestId('team-member-card');
      expect(cards).toHaveLength(3);
      const salma = cards[0]!;
      expect(within(salma).getByTestId('team-status')).toHaveTextContent('Late');
      expect(within(salma).getByText('08:00')).toBeInTheDocument(); // 04:00Z in Muscat
      expect(within(salma).getByText('Worked so far (live)')).toBeInTheDocument();
      expect(within(salma).getByText('2h 05m')).toBeInTheDocument();
      expect(within(salma).getByTestId('live-state')).toHaveTextContent('In now');
      expect(within(salma).getByText('17m late')).toBeInTheDocument();
      expect(within(salma).getByTestId('pending-badge')).toHaveTextContent('2 waiting for you');
      const yousuf = cards[1]!;
      expect(within(yousuf).getByTestId('team-status')).toHaveTextContent('On leave');
      expect(within(yousuf).getByText('Sick Leave')).toBeInTheDocument();
      expect(within(yousuf).getByText('Secondary manager')).toBeInTheDocument();
      expect(within(yousuf).getByText('Not calculated yet')).toBeInTheDocument();
      const totals = screen.getByTestId('team-totals');
      expect(within(totals).getByText('Absent').closest('div')?.parentElement).toHaveTextContent('1');
      // no search box for a team of three (Finance B-61: more than five)
      expect(screen.queryByRole('searchbox', { name: 'Search your team' })).not.toBeInTheDocument();
      // the pending badge takes the manager to the approvals tab
      fireEvent.click(within(salma).getByTestId('pending-badge'));
      expect(await screen.findByRole('tab', { name: /Approvals/, selected: true })).toBeInTheDocument();
    });

    it('offers a search once the team is larger than five (Finance B-61)', async () => {
      const members = ['Amal', 'Badr', 'Dana', 'Fahad', 'Hind', 'Khalid'].map((n, i) => teamMember({ employeeId: `e${i + 10}`, employeeName: n, employeeNumber: `E0${i + 10}` }));
      mockTeam({ '/orgs/org-1/team/summary': { data: teamSummary(members) } });
      renderWithProviders(<TeamPage />, { route: '/team' });
      expect(await screen.findAllByTestId('team-member-card')).toHaveLength(6);
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search your team' }), { target: { value: 'kha' } });
      expect(screen.getAllByTestId('team-member-card')).toHaveLength(1);
      expect(screen.getByText('Khalid')).toBeInTheDocument();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search your team' }), { target: { value: 'E012' } });
      expect(screen.getByText('Dana')).toBeInTheDocument();
    });

    it('falls back to the directory (and never asks for the board) when the role cannot read the team\'s attendance', async () => {
      grant('dashboard.view', 'employee.view_team');
      mockTeam({ '/orgs/org-1/employees': page([report('e5', 'Salma', 'e4', null), report('e6', 'Yousuf', null, 'e4')]) });
      renderWithProviders(<TeamPage />, { route: '/team' });
      expect(await screen.findByRole('link', { name: 'Salma' })).toHaveAttribute('href', '/employees/e5');
      expect(screen.getByText(/attendance\.view_team permission/)).toBeInTheDocument();
      expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/employees', expect.objectContaining({ teamOf: 'e4' }));
      expect(apiMock.get.mock.calls.some((c) => c[0] === '/orgs/org-1/team/summary')).toBe(false);
      // tabs that need a key the role lacks are not offered
      expect(screen.queryByRole('tab', { name: 'Attendance' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Leave' })).not.toBeInTheDocument();
    });

    it('opens a report\'s day read-only unless the caller may file corrections', async () => {
      mockTeam({ '/orgs/org-1/attendance/records/r5': { data: recordDetail } });
      const r = renderWithProviders(<TeamPage />, { route: '/team' });
      fireEvent.click(await screen.findByRole('button', { name: 'Open the day' }));
      await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Salma'));
      // the record endpoint admits a manager reading a report's day through the team key
      expect(apiMock.get.mock.calls.some((c) => c[0] === '/orgs/org-1/attendance/records/r5')).toBe(true);
      expect(screen.queryByRole('button', { name: 'Request correction' })).not.toBeInTheDocument();
      r.unmount();
      grant(...MANAGER_KEYS, 'attendance.correct');
      renderWithProviders(<TeamPage />, { route: '/team' });
      fireEvent.click(await screen.findByRole('button', { name: 'Open the day' }));
      expect(await screen.findByRole('button', { name: 'Request correction' })).toBeInTheDocument();
    });
  });

  describe('Attendance', () => {
    it('renders the HR month grid from /team/attendance and opens a record from a cell', async () => {
      mockTeam({
        '/orgs/org-1/team/attendance': (q: Record<string, unknown> | undefined) => page([{ employeeId: 'e5', employeeNumber: 'E005', employeeName: 'Salma', branchId: 'b1', departmentId: null, relation: 'primary', records: [daily({ attendanceDate: `${String(q?.['from']).slice(0, 8)}01` }), daily({ id: 'r6', attendanceDate: `${String(q?.['from']).slice(0, 8)}02`, status: 'ABSENT', workedMinutes: 0 })] }], 1, 1, 50),
        '/orgs/org-1/attendance/records/r5': { data: recordDetail },
      });
      renderWithProviders(<TeamPage />, { route: '/team?tab=attendance' });
      const grid = await screen.findByTestId('monthly-grid');
      expect(within(grid).getByText('Salma')).toBeInTheDocument();
      const call = apiMock.get.mock.calls.find((c) => c[0] === '/orgs/org-1/team/attendance');
      expect(call?.[1]).toMatchObject({ page: 1, pageSize: 50 });
      expect(String(call?.[1]?.from)).toMatch(/^\d{4}-\d{2}-01$/);
      fireEvent.click(within(grid).getAllByRole('button').find((b) => b.getAttribute('aria-label')?.includes('Present'))!);
      await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Salma'));
    });
  });

  describe('Leave', () => {
    it('hides the upcoming-leave card when nothing is coming (B-62) and links the pending requests to Approvals', async () => {
      mockTeam({ '/orgs/org-1/team/leave': { data: { from: '2026-09-01', to: '2026-09-30', today: '2026-09-28', entries: [teamLeave()], upcoming: [], pendingForMe: 2 } } });
      renderWithProviders(<TeamPage />, { route: '/team?tab=leave' });
      expect(await screen.findByTestId('team-leave-calendar')).toHaveTextContent('Yousuf Al Balushi');
      expect(screen.queryByTestId('team-upcoming-leave')).not.toBeInTheDocument();
      expect(screen.getByTestId('team-leave-pending')).toHaveTextContent('2 leave requests are waiting for you');
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
      expect(await screen.findByRole('tab', { name: /Approvals/, selected: true })).toBeInTheDocument();
    });

    it('lists the upcoming leave when there is some', async () => {
      mockTeam({ '/orgs/org-1/team/leave': { data: { from: '2026-09-01', to: '2026-09-30', today: '2026-09-28', entries: [teamLeave()], upcoming: [teamLeave({ status: 'PENDING' })], pendingForMe: 0 } } });
      renderWithProviders(<TeamPage />, { route: '/team?tab=leave' });
      const card = await screen.findByTestId('team-upcoming-leave');
      expect(within(card).getByText('Yousuf Al Balushi')).toBeInTheDocument();
      expect(within(card).getByText('Pending')).toBeInTheDocument();
      expect(screen.queryByTestId('team-leave-pending')).not.toBeInTheDocument();
    });
  });

  describe('Approvals', () => {
    const inbox = (q: Record<string, unknown> | undefined) => {
      if (q?.['scope'] === 'team') return page(q['view'] === 'history'
        ? [approvalRequest({ id: 'h1', status: 'APPROVED', employeeName: 'Huda', createdAt: '2026-09-20T08:00:00Z', abilities: { ...approvalRequest().abilities, canDecide: false } })]
        : [approvalRequest({ id: 'p9', employeeName: 'Amal', createdAt: '2026-09-25T08:00:00Z', abilities: { ...approvalRequest().abilities, canDecide: true } })]);
      return page([
        approvalRequest({ id: 'r1', employeeName: 'Salma', entityType: 'LEAVE', context: leaveContext() }),
        approvalRequest({ id: 'r2', employeeName: 'Yousuf', abilities: { ...approvalRequest().abilities, canDecide: false } }),
        approvalRequest({ id: 'r3', employeeName: 'Salma', entityType: 'ATTENDANCE_NOTE' }),
      ]);
    };

    it('shows what waits for the manager: decisions only on rows assigned to them and pending (B-65); reasons with Prompt 4\'s actions', async () => {
      mockTeam({
        '/orgs/org-1/team/pending-counts': { data: { approvals: 1, notes: 2, total: 3 } },
        '/orgs/org-1/approvals': inbox,
        '/orgs/org-1/attendance/notes': page([
          reviewNote({ id: 'n1', employeeName: 'Salma' }),
          reviewNote({ id: 'n2', employeeName: 'Yousuf', status: 'info_requested', infoRequestMessage: 'Which road?', canReview: true }),
          reviewNote({ id: 'n3', employeeName: 'Huda', isOversight: true, excusedCountYear: 0 }),
        ]),
      });
      renderWithProviders(<TeamPage />, { route: '/team?tab=approvals' });
      expect(await screen.findByTestId('approvals-tab-count')).toHaveTextContent('3');
      const rows = await screen.findAllByTestId('team-request-row');
      // the reason request is listed with the reasons, not twice
      expect(rows.map((r) => r.getAttribute('data-entity'))).toEqual(['LEAVE', 'ATTENDANCE_CORRECTION']);
      expect(within(rows[0]!).getByRole('button', { name: /Approve/ })).toBeInTheDocument();
      expect(within(rows[1]!).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
      const notes = await screen.findAllByTestId('team-note-row');
      expect(notes).toHaveLength(3);
      expect(within(notes[0]!).getByTestId('excused-count')).toHaveTextContent('2');
      expect(within(notes[0]!).getByRole('button', { name: /Excuse/ })).toBeInTheDocument();
      expect(within(notes[0]!).getByRole('button', { name: /Ask/ })).toBeInTheDocument();
      // waiting for the employee's answer: nothing to decide
      expect(within(notes[1]!).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
      expect(within(notes[1]!).getByText(/Which road\?/)).toBeInTheDocument();
      // seen through HR oversight: marked, and not decided here
      expect(within(notes[2]!).getByTestId('oversight-chip')).toBeInTheDocument();
      expect(within(notes[2]!).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
      expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/attendance/notes', expect.objectContaining({ scope: 'mine', open: true }));
    });

    it('rejects a reason with a half-day pay effect', async () => {
      mockTeam({ '/orgs/org-1/approvals': inbox, '/orgs/org-1/attendance/notes': page([reviewNote({ id: 'n1', employeeName: 'Salma' })]) });
      apiMock.post.mockResolvedValue({ data: { note: reviewNote({ status: 'rejected' }), requestStatus: null, terminal: true, charge: { outcome: 'charged_leave', payEffectDays: 0.5, leaveTypeCode: 'AL' } } });
      renderWithProviders(<TeamPage />, { route: '/team?tab=approvals' });
      const [note] = await screen.findAllByTestId('team-note-row');
      fireEvent.click(within(note!).getByRole('button', { name: /Reject/ }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Half day' }));
      fireEvent.click(within(dialog).getByRole('button', { name: /Reject/ }));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/notes/n1/review', { decision: 'reject', payEffectDays: 0.5 }));
    });

    it('"All my team" lists the reports\' recent requests view only (B-64)', async () => {
      mockTeam({ '/orgs/org-1/approvals': inbox, '/orgs/org-1/attendance/notes': page([]) });
      renderWithProviders(<TeamPage />, { route: '/team?tab=approvals' });
      fireEvent.click(await screen.findByRole('button', { name: 'All my team' }));
      const list = await screen.findByTestId('team-requests-view-only');
      const rows = within(list).getAllByTestId('team-request-row');
      // newest first, pending and decided merged
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent('Amal');
      expect(rows[1]).toHaveTextContent('Huda');
      // view only, even on a row the caller could decide in the inbox
      expect(within(list).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
      expect(within(list).getAllByText('View only')).toHaveLength(2);
      expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/approvals', expect.objectContaining({ scope: 'team', view: 'history', pageSize: 50 }));
    });
  });

  it('Delegation embeds the delegations list with its create action', async () => {
    mockTeam({ '/orgs/org-1/approval-delegations': { data: [{ id: 'd1', organizationId: 'org-1', delegatorUserId: 'u1', delegatorName: 'Dev', delegateUserId: 'u9', delegateName: 'Nasser', entityTypes: null, startsOn: '2026-09-01', endsOn: '2099-12-31', reason: 'Annual leave', isActive: true, createdBy: 'u1', createdAt: '2026-09-01T00:00:00Z', revokedAt: null, revokedBy: null }] } });
    renderWithProviders(<TeamPage />, { route: '/team?tab=delegation' });
    expect(await screen.findByText('Nasser')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delegate my approvals/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the delegations page' })).toHaveAttribute('href', '/approvals/delegations');
  });
});
