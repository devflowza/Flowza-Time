import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { NotesReportRowDto, RegularisationAdminItemDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/attendance/workspace-api', async (orig) => ({ ...(await orig<object>()), saveTextFile: vi.fn() }));

import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { saveTextFile } from '@/features/attendance/workspace-api';
import RegularisationsPage from './pages/regularisations-page';
import { NotesReport } from './components/notes-report';
import { RosterTab } from './components/roster-tab';
import { decidable, impactDays, inclusiveDays, presentFilters, rosterCode } from './model';

const reg = (over: Partial<RegularisationAdminItemDto> = {}): RegularisationAdminItemDto => ({
  id: 'g1', employeeId: 'e5', attendanceDate: '2026-09-20', type: 'missed_punch', proposedInAt: '2026-09-20T04:00:00Z', proposedOutAt: '2026-09-20T13:00:00Z', reason: 'Terminal offline at the gate',
  status: 'pending', approvalRequestId: 'req-1', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 2, appliedCorrectionId: null, appliedAt: null, decidedByName: null, decidedAt: null, decisionNote: null,
  createdAt: '2026-09-20T15:00:00Z', updatedAt: '2026-09-20T15:00:00Z', employeeName: 'Salma Al Harthy', employeeNumber: 'E005', branchId: 'b1', branchName: 'Muscat', departmentId: null, departmentName: 'IT',
  approval: { requestId: 'req-1', status: 'PENDING', currentStep: 1, stepCount: 2, approverType: 'MANAGER', approvers: [{ userId: 'u7', name: 'Khalid', decision: 'PENDING' }], infoRequested: false, canDecide: true, decideVia: 'actor' },
  ...over,
});

const noteRow = (over: Partial<NotesReportRowDto> = {}): NotesReportRowDto => ({
  id: 'n1', employeeId: 'e5', employeeName: 'Salma Al Harthy', employeeNumber: 'E005', branchId: 'b1', branchName: 'Muscat', departmentName: 'IT', attendanceDate: '2026-09-21', dayStatus: 'ABSENT', dayFlags: [],
  category: 'absence_reason', note: 'Flat tyre', status: 'rejected', approvalStatus: 'REJECTED', approvalCurrentStep: 1, approvalStepCount: 1, submittedAt: '2026-09-21T10:00:00Z', reviewedByName: 'Khalid', reviewedAt: '2026-09-22T06:00:00Z',
  reviewVia: 'manager', reviewReason: 'No evidence', payEffectDays: 0.5, impact: 'leave', lossOfPay: false, deductedLeaveTypeCode: 'AL', deductedLeaveTypeName: 'Annual Leave', deductedLeaveDays: 0.5, excusedCountYear: 1, isOversight: false,
  ...over,
});

describe('attendance admin model', () => {
  it('decides only pending rows whose current level the caller may decide', () => {
    expect(decidable(reg())).toBe(true);
    expect(decidable(reg({ status: 'approved' }))).toBe(false);
    expect(decidable(reg({ approval: { ...reg().approval!, canDecide: false } }))).toBe(false);
    expect(decidable(reg({ approval: null }))).toBe(false);
  });
  it('sends only the filters that carry a value, counts range days and the charged days', () => {
    expect(presentFilters(['status', 'type', 'search'] as const, { status: 'pending', type: '', search: undefined })).toEqual({ status: 'pending' });
    expect(inclusiveDays('2026-01-01', '2026-12-31')).toBe(365);
    expect(inclusiveDays('2026-02-01', '2026-01-01')).toBe(0);
    expect(impactDays(noteRow())).toBe(0.5);
    expect(impactDays(noteRow({ impact: 'lop', payEffectDays: 1, deductedLeaveDays: null }))).toBe(1);
    expect(impactDays(noteRow({ impact: 'excused' }))).toBe(0);
  });
});

describe('RegularisationsPage (HR portal Prompt 6b)', () => {
  beforeEach(() => {
    resetApiMock();
    testState.employeeId = null; testState.teamSize = 0;
    grant('attendance.approve', 'attendance.view', 'report.export');
  });

  const mock = (rows: RegularisationAdminItemDto[]) => mockGet({ '/orgs/org-1/attendance/regularisations': page(rows), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]) });

  it('lists the register with the current level, its approvers and the applied correction', async () => {
    mock([reg(), reg({ id: 'g2', status: 'approved', appliedCorrectionId: 'c1', appliedAt: '2026-09-21T05:00:00Z', decidedByName: 'Khalid', decidedAt: '2026-09-21T05:00:00Z', approval: { ...reg().approval!, status: 'APPROVED', currentStep: 2, canDecide: false, approvers: [] } })]);
    renderWithProviders(<RegularisationsPage />, { route: '/attendance/regularisations' });
    expect((await screen.findAllByText('Salma Al Harthy')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Level 1 of 2')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Line manager')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Waiting on Khalid')[0]).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open the correction' })[0]).toHaveAttribute('href', '/corrections?employeeId=e5&from=2026-09-20&to=2026-09-20');
    expect(screen.getAllByText('In 08:00')[0]).toBeInTheDocument();
  });

  it('decides through the engine: approve names the level seen; reject requires a comment', async () => {
    mock([reg()]);
    apiMock.post.mockResolvedValue({ data: { id: 'g1', ok: true, status: 'pending', requestStatus: 'PENDING', advanced: true } });
    renderWithProviders(<RegularisationsPage />, { route: '/attendance/regularisations' });
    fireEvent.click((await screen.findAllByRole('button', { name: /^Reject$/ }))[0]!);
    let dialog = await screen.findByRole('dialog');
    const submitReject = within(dialog).getByRole('button', { name: /Reject/ });
    expect(submitReject).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Comment/), { target: { value: 'Not supported by the gate log' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/regularisations/g1/decide', { decision: 'reject', comment: 'Not supported by the gate log', stepNo: 1 }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: /^Approve$/ })[0]!);
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/regularisations/g1/decide', { decision: 'approve', comment: undefined, stepNo: 1 }, expect.anything()));
  });

  it('bulk-decides the selected rows and reports one line per item', async () => {
    mock([reg(), reg({ id: 'g2', employeeName: 'Yousuf', approval: { ...reg().approval!, canDecide: false } })]);
    apiMock.post.mockResolvedValue({ data: { results: [{ id: 'g1', ok: true, status: 'approved', requestStatus: 'APPROVED', advanced: false }, { id: 'g2', ok: false, status: 'pending', requestStatus: 'PENDING', advanced: false, code: 'FORBIDDEN', message: 'You are not an approver of this level.' }], succeeded: 1, failed: 1 } });
    renderWithProviders(<RegularisationsPage />, { route: '/attendance/regularisations' });
    await screen.findAllByText('Yousuf');
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select all' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: /Approve selected/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Approve 2 regularisations');
    fireEvent.click(within(dialog).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/regularisations/bulk-decide', { items: [{ id: 'g1', stepNo: 1 }, { id: 'g2', stepNo: 1 }], decision: 'approve', comment: undefined }, expect.anything()));
    const results = await screen.findByTestId('bulk-results');
    expect(results).toHaveTextContent('Decided');
    expect(results).toHaveTextContent('Refused: You are not an approver of this level.');
    expect(screen.getByText('1 decided · 1 refused')).toBeInTheDocument();
  });

  it('exports the filtered register as CSV only with report.export', async () => {
    mockGet({
      '/orgs/org-1/attendance/regularisations': page([reg()]), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]),
      '/orgs/org-1/attendance/regularisations/export': { data: { fileName: 'regularisations-2026-09-28.csv', contentType: 'text/csv', content: 'a,b', rowCount: 1 } },
    });
    const r = renderWithProviders(<RegularisationsPage />, { route: '/attendance/regularisations?status=pending' });
    fireEvent.click(await screen.findByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'regularisations-2026-09-28.csv' })));
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/attendance/regularisations/export', { status: 'pending' });
    r.unmount();
    grant('attendance.approve', 'attendance.view');
    renderWithProviders(<RegularisationsPage />, { route: '/attendance/regularisations' });
    await screen.findAllByText('Salma Al Harthy');
    expect(screen.queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument();
  });
});

describe('NotesReport (comments & approvals, HR portal Prompt 6b)', () => {
  beforeEach(() => { resetApiMock(); grant('attendance.view', 'attendance.review_notes', 'report.export'); });

  it('shows each reason with its review, pay effect, leave impact and excused count, and the totals', async () => {
    mockGet({ '/orgs/org-1/attendance/notes/report': { data: [noteRow(), noteRow({ id: 'n2', status: 'approved', impact: 'none', payEffectDays: null, deductedLeaveTypeName: null, deductedLeaveDays: null, isOversight: true, reviewVia: 'oversight' })], meta: { page: 1, pageSize: 50, total: 2, totalPages: 1, totals: { total: 2, pending: 0, approved: 1, rejected: 1, excused: 0, infoRequested: 0, lopDays: 0, leaveDays: 0.5 } } }, '/orgs/org-1/branches': page([]) });
    renderWithProviders(<NotesReport oversight />);
    const rows = await screen.findAllByTestId('notes-report-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('0.5 d Annual Leave');
    expect(rows[0]).toHaveTextContent('as line manager');
    expect(rows[1]).toHaveTextContent('HR oversight');
    expect(screen.getByTestId('notes-report-totals')).toHaveTextContent('Leave days charged0.5');
    const call = apiMock.get.mock.calls.find((c) => c[0] === '/orgs/org-1/attendance/notes/report');
    expect(call?.[1]).toMatchObject({ scope: 'all', page: 1, pageSize: 50 });
  });

  it('exports the report as CSV (report.export) and refuses a range over 366 days before asking', async () => {
    mockGet({ '/orgs/org-1/attendance/notes/report': { data: [], meta: { page: 1, pageSize: 50, total: 0, totalPages: 1, totals: { total: 0, pending: 0, approved: 0, rejected: 0, excused: 0, infoRequested: 0, lopDays: 0, leaveDays: 0 } } }, '/orgs/org-1/branches': page([]),
      '/orgs/org-1/attendance/notes/report/export': { data: { fileName: 'attendance-comments.csv', contentType: 'text/csv', content: 'x', rowCount: 0 } } });
    renderWithProviders(<NotesReport oversight />);
    fireEvent.click(await screen.findByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'attendance-comments.csv' })));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2024-01-01' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 366 days');
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeDisabled();
  });

  it('offers a line manager only their own scopes', async () => {
    grant('dashboard.view');
    testState.teamSize = 2;
    mockGet({ '/orgs/org-1/attendance/notes/report': { data: [], meta: { page: 1, pageSize: 50, total: 0, totalPages: 1, totals: { total: 0, pending: 0, approved: 0, rejected: 0, excused: 0, infoRequested: 0, lopDays: 0, leaveDays: 0 } } }, '/orgs/org-1/branches': page([]) });
    renderWithProviders(<NotesReport oversight={false} />);
    expect(await screen.findByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Organisation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument();
    testState.teamSize = 0;
  });
});

describe('RosterTab (monthly roster, Finance ATT-105)', () => {
  beforeEach(() => { resetApiMock(); grant('shift.view'); });

  it('shows the engine\'s shift per day: code in the shift colour, Off, holiday, leave, a dash when nothing resolves', async () => {
    const shift = { id: 's1', code: 'day', name: 'Day shift', type: 'FIXED' as const, startTime: '08:00', endTime: '17:00', requiredMinutes: null, graceInMinutes: 10, crossesMidnight: false, color: '#0ea5e9', breakMinutes: 60 };
    const day = (over: object = {}) => ({ shiftId: 's1', source: 'ASSIGNMENT', isOff: false, holidayName: null, onLeave: false, ...over });
    mockGet({
      '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]),
      '/orgs/org-1/shift-roster': (q: Record<string, unknown> | undefined) => ({ data: { month: String(q?.['month']), from: '2026-02-01', to: '2026-02-05', dates: ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05'], shifts: [shift], rows: [{ employeeId: 'e5', employeeNumber: 'E005', employeeName: 'Salma', branchId: 'b1', branchName: 'Muscat', departmentName: null, days: {
        '2026-02-01': day(), '2026-02-02': day({ isOff: true }), '2026-02-03': day({ holidayName: 'Founders Day' }), '2026-02-04': day({ onLeave: true }), '2026-02-05': day({ shiftId: null, source: 'NONE' }),
      } }] }, meta: { page: 1, pageSize: 50, total: 1, totalPages: 1 } }),
    });
    renderWithProviders(<RosterTab />);
    const row = await screen.findByTestId('roster-row');
    const cell = (d: string) => row.querySelector(`[data-date="${d}"]`)!;
    expect(cell('2026-02-01')).toHaveTextContent('DA');
    expect(cell('2026-02-01')).toHaveAttribute('title', expect.stringContaining('Day shift 08:00–17:00 (assignment)'));
    expect(cell('2026-02-02')).toHaveTextContent('Off');
    expect(cell('2026-02-03')).toHaveTextContent('H');
    expect(cell('2026-02-03')).toHaveAttribute('title', expect.stringContaining('Founders Day'));
    expect(cell('2026-02-04')).toHaveTextContent('L');
    expect(cell('2026-02-05')).toHaveTextContent('–');
    expect(screen.getByText('Day shift')).toBeInTheDocument();
    expect(rosterCode('night')).toBe('NI');
    const call = apiMock.get.mock.calls.find((c) => c[0] === '/orgs/org-1/shift-roster');
    expect(String(call?.[1]?.month)).toMatch(/^\d{4}-\d{2}$/);
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(apiMock.get.mock.calls.filter((c) => c[0] === '/orgs/org-1/shift-roster').length).toBeGreaterThan(1));
  });
});
