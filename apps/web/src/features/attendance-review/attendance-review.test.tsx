import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { AttendanceNoteReviewItemDto, GeofenceDto, SelfieCheckinDto } from '@flowza/contracts';
import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enApprovals from '@/locales/en/approvals.json';
import arApprovals from '@/locales/ar/approvals.json';
import { Sidebar } from '@/components/layout/sidebar';
import { DecisionDialog } from '@/features/approvals/components/decision-dialog';
import { approvalRequest, approvalStep } from '@/features/approvals/test-fixtures';
import './routes';
import NotesReviewPage from './pages/notes-review-page';
import GeofencesPage from './pages/geofences-page';
import { AttendanceGrantsCard } from './components/attendance-grants-card';
import { SelfieReviewPanel } from './components/selfie-review';
import { defaultPayEffect } from './model';

registerNamespace('approvals', enApprovals, arApprovals);

const ORG = 'org-1';
const item = (over: Partial<AttendanceNoteReviewItemDto> = {}): AttendanceNoteReviewItemDto => ({
  id: 'n1', employeeId: 'e1', attendanceDate: '2026-09-20', category: 'late_reason', note: 'Road closed', status: 'pending', submittedAt: '2026-09-20T09:00:00Z',
  reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewReason: null, reviewVia: null, infoRequestMessage: null, infoRequestedAt: null, payEffectDays: null, lossOfPay: false,
  deductedLeaveTypeCode: null, deductedLeaveTypeName: null, approvalRequestId: 'req-1', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1, excusedAt: null,
  createdAt: '2026-09-20T09:00:00Z', updatedAt: '2026-09-20T09:00:00Z', employeeName: 'Ali Said', employeeNumber: 'A-001', branchId: 'b1', branchName: 'HQ',
  dayStatus: 'PRESENT', dayFlags: ['LATE'], firstInAt: '2026-09-20T04:40:00Z', lastOutAt: '2026-09-20T13:05:00Z', timezone: 'Asia/Muscat', excusedCountYear: 2, isOversight: false, canReview: true,
  ...over,
});

beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = ORG; testState.employeeId = null; testState.teamSize = 0; testState.settings = {}; });

describe('review navigation', () => {
  it('shows the reasons page to reviewers and line managers, geofences to their managers only', () => {
    grant('attendance.review_notes', 'attendance.view');
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Attendance reasons' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Geofences' })).not.toBeInTheDocument();
    grant('attendance.manage_geofences');
    renderWithProviders(<Sidebar />);
    expect(screen.getAllByRole('link', { name: 'Geofences' })).toHaveLength(1);
  });

  it('a line manager without any key still reaches the reasons of the team', () => {
    grant();
    testState.teamSize = 2;
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Attendance reasons' })).toBeInTheDocument();
  });
});

describe('NotesReviewPage', () => {
  it('lists waiting reasons with the day and the excused count, and rejects with the chosen pay effect', async () => {
    mockGet({ [`/orgs/${ORG}/attendance/notes`]: page([item()]) });
    apiMock.post.mockResolvedValue({ data: { note: item({ status: 'rejected' }), requestStatus: 'REJECTED', terminal: true, charge: { outcome: 'charged_leave', payEffectDays: 0.5, leaveTypeCode: 'AL' } } });
    renderWithProviders(<NotesReviewPage />, { route: '/attendance/notes' });
    const row = await screen.findByTestId('note-review-row');
    expect(within(row).getByText('Road closed')).toBeInTheDocument();
    expect(within(row).getByTestId('excused-count')).toHaveTextContent('2 days excused this year');
    expect(apiMock.get).toHaveBeenCalledWith(`/orgs/${ORG}/attendance/notes`, expect.objectContaining({ scope: 'mine', open: true }));
    fireEvent.click(within(row).getByRole('button', { name: /Reject/ }));
    const dialog = await screen.findByRole('dialog');
    // a late day proposes half a day by default (organisation default payEffectLate)
    expect(within(dialog).getByRole('radio', { name: 'Half day' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Full day' }));
    fireEvent.change(within(dialog).getByLabelText(/Comment/), { target: { value: 'No proof of the closure' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/attendance/notes/n1/review`, { decision: 'reject', reason: 'No proof of the closure', payEffectDays: 1 }));
  });

  it('excuses a day and asks for information only with a question', async () => {
    mockGet({ [`/orgs/${ORG}/attendance/notes`]: page([item()]) });
    apiMock.post.mockResolvedValue({ data: { note: item({ status: 'excused' }), requestStatus: 'APPROVED', terminal: true, charge: null } });
    renderWithProviders(<NotesReviewPage />, { route: '/attendance/notes' });
    const row = await screen.findByTestId('note-review-row');
    fireEvent.click(within(row).getByRole('button', { name: /Ask/ }));
    let dialog = await screen.findByRole('dialog');
    const ask = within(dialog).getByRole('button', { name: /Ask/ });
    expect(ask).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Question/), { target: { value: 'Which road?' } });
    fireEvent.click(ask);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/attendance/notes/n1/review`, { decision: 'request_info', reason: 'Which road?' }));
    fireEvent.click(within(row).getByRole('button', { name: /Excuse/ }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Excuse/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/attendance/notes/n1/review`, { decision: 'excuse' }));
  });

  it('warns HR that the organisation scope is oversight, and hides it from a plain line manager', async () => {
    grant('attendance.view', 'attendance.review_notes');
    mockGet({ [`/orgs/${ORG}/attendance/notes`]: page([item({ isOversight: true })]) });
    renderWithProviders(<NotesReviewPage />, { route: '/attendance/notes?scope=all' });
    expect(await screen.findByTestId('oversight-banner')).toHaveTextContent('organisation-wide oversight');
    expect(apiMock.get).toHaveBeenCalledWith(`/orgs/${ORG}/attendance/notes`, expect.objectContaining({ scope: 'all' }));
    expect(await screen.findByText('Oversight')).toBeInTheDocument();

    grant();
    testState.teamSize = 1;
    renderWithProviders(<NotesReviewPage />, { route: '/attendance/notes?scope=all' });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Assigned to me' })).toHaveLength(2));
    expect(screen.getAllByRole('button', { name: 'Organisation' })).toHaveLength(1); // only the first render's
  });

  it('4-seat-choice an organisation-wide reviewer names whose seat the decision fills on a level waiting for several reviewers', async () => {
    const hr = (userId: string, userName: string) => ({ userId, userName, viaDelegationOf: null, viaDelegationOfName: null, onBehalfOfUserId: null, onBehalfOfName: null, resolutionPath: 'hr_admin', decision: 'PENDING' as const, decidedAt: null, comment: null });
    const seats = [{ userId: 'u7', userName: 'Fatma HR' }, { userId: 'u8', userName: 'Salim HR' }];
    const request = approvalRequest({ entityType: 'ATTENDANCE_NOTE', abilities: { canDecide: true, canCancel: false, canReassign: false, canBypass: false, canRequestInfo: true, canAnswerInfo: false, actingAsDelegateOf: null, decideVia: 'override', mustChooseSeat: true }, steps: [approvalStep({ mode: 'ALL', actors: [hr('u7', 'Fatma HR'), hr('u8', 'Salim HR')], pendingSeats: seats })] });
    mockGet({ [`/orgs/${ORG}/attendance/notes`]: page([item({ isOversight: true })]), [`/orgs/${ORG}/approvals/req-1`]: { data: request } });
    apiMock.post.mockResolvedValue({ data: { note: item({ status: 'approved' }), requestStatus: 'PENDING', terminal: false, charge: null } });
    renderWithProviders(<NotesReviewPage />, { route: '/attendance/notes' });
    const row = await screen.findByTestId('note-review-row');
    fireEvent.click(within(row).getByRole('button', { name: /Approve/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('note-review-seat-hint')).toHaveTextContent(/choose whose seat it fills/);
    const approve = within(dialog).getByRole('button', { name: /Approve/ });
    expect(approve).toBeDisabled();
    fireEvent.keyDown(within(dialog).getByLabelText(/Deciding for/), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Salim HR' }));
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/attendance/notes/n1/review`, { decision: 'approve', onBehalfOfUserId: 'u8' }));
  });

  it('4-seat-choice a single waiting seat is named for the reviewer, never asked; a seated line manager fills their own seat', async () => {
    const one = approvalRequest({ entityType: 'ATTENDANCE_NOTE', abilities: { canDecide: true, canCancel: false, canReassign: false, canBypass: false, canRequestInfo: true, canAnswerInfo: false, actingAsDelegateOf: null, decideVia: 'override', mustChooseSeat: false }, steps: [approvalStep({ pendingSeats: [{ userId: 'u9', userName: 'Nasser' }] })] });
    mockGet({ [`/orgs/${ORG}/attendance/notes`]: page([item()]), [`/orgs/${ORG}/approvals/req-1`]: { data: one } });
    apiMock.post.mockResolvedValue({ data: { note: item({ status: 'excused' }), requestStatus: 'APPROVED', terminal: true, charge: null } });
    renderWithProviders(<NotesReviewPage />, { route: '/attendance/notes' });
    const row = await screen.findByTestId('note-review-row');
    fireEvent.click(within(row).getByRole('button', { name: /Excuse/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('note-review-seat-hint')).toHaveTextContent(/Nasser/);
    expect(within(dialog).queryByLabelText(/Deciding for/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /Excuse/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/attendance/notes/n1/review`, { decision: 'excuse', onBehalfOfUserId: 'u9' }));
  });

  it('shows who decided a closed reason and what the rejection cost', async () => {
    mockGet({ [`/orgs/${ORG}/attendance/notes`]: page([item({ status: 'rejected', canReview: false, reviewedByName: 'Mansoor', reviewReason: 'No proof', payEffectDays: 1, lossOfPay: true })]) });
    renderWithProviders(<NotesReviewPage />, { route: '/attendance/notes?status=rejected' });
    const row = await screen.findByTestId('note-review-row');
    expect(within(row).getByText('Mansoor: No proof')).toBeInTheDocument();
    expect(within(row).getByText('1 day loss of pay')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Reject/ })).not.toBeInTheDocument();
  });
});

describe('SelfieReviewPanel', () => {
  const selfie = (over: Partial<SelfieCheckinDto> = {}): SelfieCheckinDto => ({ id: 's1', employeeId: 'e1', employeeName: 'Ali Said', employeeNumber: 'A-001', punchedAt: '2026-09-27T04:02:00Z', direction: 'in', latitude: 23.6, longitude: 58.4, accuracyM: 20, verdict: 'flagged', status: 'pending', reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewReason: null, rawTransactionId: null, createdAt: '2026-09-27T04:02:00Z', viaManager: true, ...over });

  it('approves a selfie and opens its photo only on demand', async () => {
    mockGet({ [`/orgs/${ORG}/attendance/selfie-checkins`]: page([selfie()]), [`/orgs/${ORG}/attendance/selfie-checkins/s1/photo`]: { data: { url: 'https://signed.example/s1.jpg', expiresInSeconds: 60 } } });
    apiMock.post.mockResolvedValue({ data: selfie({ status: 'approved' }) });
    renderWithProviders(<SelfieReviewPanel />);
    const row = await screen.findByTestId('selfie-review-row');
    expect(apiMock.get).not.toHaveBeenCalledWith(`/orgs/${ORG}/attendance/selfie-checkins/s1/photo`, undefined);
    fireEvent.click(within(row).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/attendance/selfie-checkins/s1/review`, { decision: 'approve' }));
    fireEvent.click(within(row).getByRole('button', { name: /Photo/ }));
    expect(await screen.findByRole('img', { name: 'Selfie of Ali Said' })).toHaveAttribute('src', 'https://signed.example/s1.jpg');
  });

  it('rejects only with a reason', async () => {
    mockGet({ [`/orgs/${ORG}/attendance/selfie-checkins`]: page([selfie()]) });
    apiMock.post.mockResolvedValue({ data: selfie({ status: 'rejected' }) });
    renderWithProviders(<SelfieReviewPanel />);
    const row = await screen.findByTestId('selfie-review-row');
    fireEvent.click(within(row).getByRole('button', { name: /Reject/ }));
    const dialog = await screen.findByRole('dialog');
    const reject = within(dialog).getByRole('button', { name: /Reject/ });
    expect(reject).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Face not visible' } });
    fireEvent.click(reject);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/attendance/selfie-checkins/s1/review`, { decision: 'reject', reason: 'Face not visible' }));
  });

  it('offers only what the API allows the caller (a reader sees the row, not the face; a reviewer of reasons sees, never decides)', async () => {
    mockGet({ [`/orgs/${ORG}/attendance/selfie-checkins`]: page([selfie({ id: 's1', canReview: false, canViewPhoto: false }), selfie({ id: 's2', employeeName: 'Mona Ali', canReview: false, canViewPhoto: true })]) });
    renderWithProviders(<SelfieReviewPanel />);
    const [reader, hr] = await screen.findAllByTestId('selfie-review-row');
    expect(within(reader!).queryByRole('button', { name: /Photo/ })).not.toBeInTheDocument();
    expect(within(reader!).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(within(reader!).queryByRole('button', { name: /Reject/ })).not.toBeInTheDocument();
    expect(within(hr!).getByRole('button', { name: /Photo/ })).toBeInTheDocument();
    expect(within(hr!).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });
});

describe('GeofencesPage', () => {
  const fence = (over: Partial<GeofenceDto> = {}): GeofenceDto => ({ id: 'g1', organizationId: ORG, branchId: null, branchName: null, name: 'HQ', latitude: 23.588, longitude: 58.3829, radiusM: 150, polygon: null, enforcement: 'hard_block', accuracyThresholdM: 100, graceM: 0, activeFrom: null, activeTo: null, timeWindows: [], isActive: true, assignments: [], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...over });

  it('lists fences, flags one that applies to nobody and creates a new one', async () => {
    mockGet({ [`/orgs/${ORG}/geofences`]: { data: [fence()] }, [`/orgs/${ORG}/branches`]: page([]), '*': page([]) });
    apiMock.post.mockResolvedValue({ data: fence({ id: 'g2', name: 'Yard' }) });
    renderWithProviders(<GeofencesPage />);
    const row = await screen.findByTestId('geofence-row');
    expect(within(row).getByText('Nobody')).toBeInTheDocument();
    expect(within(row).getByText('Refuse the punch')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /New geofence/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Give the zone a name.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Yard' } });
    fireEvent.change(within(dialog).getByLabelText(/^Latitude/), { target: { value: '23.6' } });
    fireEvent.change(within(dialog).getByLabelText(/^Longitude/), { target: { value: '58.4' } });
    fireEvent.change(within(dialog).getByLabelText(/Polygon/), { target: { value: '23.60, 58.40\n23.61, 58.40\n23.61, 58.41' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/geofences`, expect.objectContaining({ name: 'Yard', latitude: 23.6, longitude: 58.4, radiusM: 150, polygon: [[23.6, 58.4], [23.61, 58.4], [23.61, 58.41]], enforcement: 'soft_warn', branchId: null })));
  });

  it('4-P0-1 a fence the caller may not change is read-only and says why; the precedence rule is on the page (ATT-63/64)', async () => {
    mockGet({ [`/orgs/${ORG}/geofences`]: { data: [fence({ id: 'g1', name: 'HQ', editable: false, hiddenAssignments: 2 }), fence({ id: 'g2', name: 'Org zone', editable: false, hiddenAssignments: 0 }), fence({ id: 'g3', name: 'Mine', editable: true, hiddenAssignments: 0 })] }, '*': page([]) });
    renderWithProviders(<GeofencesPage />);
    const rows = await screen.findAllByTestId('geofence-row');
    expect(rows.map((r) => r.getAttribute('data-editable'))).toEqual(['false', 'false', 'true']);
    expect(within(rows[0]!).getByTestId('geofence-read-only')).toHaveTextContent('it also applies to 2 targets outside your branches');
    expect(within(rows[1]!).getByTestId('geofence-read-only')).toHaveTextContent('another branch or to the whole organisation');
    for (const name of [/Applies to|Assign/, 'Edit geofence', 'Delete']) expect(within(rows[0]!).getByRole('button', { name })).toBeDisabled();
    expect(within(rows[2]!).getByRole('button', { name: 'Edit geofence' })).toBeEnabled();
    expect(screen.getByTestId('geofence-precedence')).toHaveTextContent(/most specific assignment .* wins .* worst result decides/);
  });

  it('runs the dry-run tester', async () => {
    mockGet({ [`/orgs/${ORG}/geofences`]: { data: [] }, [`/orgs/${ORG}/employees`]: page([{ id: 'e1', displayName: 'Ali Said', employeeNumber: 'A-001' }]), '*': page([]) });
    renderWithProviders(<GeofencesPage />);
    expect(await screen.findByTestId('geofence-tester')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
  });
});

describe('AttendanceGrantsCard', () => {
  it('lets an attendance approver switch open attendance on', async () => {
    grant('attendance.approve');
    mockGet({ [`/orgs/${ORG}/employees/e1/attendance-grants`]: { data: { employeeId: 'e1', openAttendance: false, selfieRequired: false, grantedBy: null, grantedByName: null, grantedAt: null } } });
    apiMock.put.mockResolvedValue({ data: { employeeId: 'e1', openAttendance: true, selfieRequired: false, grantedBy: 'u1', grantedByName: 'Dev', grantedAt: '2026-09-27T05:00:00Z' } });
    renderWithProviders(<AttendanceGrantsCard employeeId="e1" />);
    fireEvent.click(await screen.findByRole('switch', { name: /Open attendance/ }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith(`/orgs/${ORG}/employees/e1/attendance-grants`, { openAttendance: true, selfieRequired: false }));
    expect(await screen.findByText(/Last changed by Dev/)).toBeInTheDocument();
  });

  it('says a required selfie is dormant while the organisation\'s selfie check-in is off', async () => {
    grant('attendance.approve');
    const dto = { employeeId: 'e1', openAttendance: false, selfieRequired: true, grantedBy: null, grantedByName: null, grantedAt: null };
    mockGet({ [`/orgs/${ORG}/employees/e1/attendance-grants`]: { data: { ...dto, selfieCheckInEnabled: false } } });
    const { unmount } = renderWithProviders(<AttendanceGrantsCard employeeId="e1" />);
    expect(await screen.findByTestId('grants-selfie-off')).toHaveTextContent(/Selfie check-in is turned off for the organisation/);
    unmount();
    mockGet({ [`/orgs/${ORG}/employees/e1/attendance-grants`]: { data: { ...dto, selfieCheckInEnabled: true } } });
    renderWithProviders(<AttendanceGrantsCard employeeId="e1" />);
    await screen.findByRole('switch', { name: /Selfie required/ });
    expect(screen.queryByTestId('grants-selfie-off')).not.toBeInTheDocument();
  });

  it('renders nothing for someone who may not manage it', () => {
    grant('employee.view');
    const { container } = renderWithProviders(<AttendanceGrantsCard employeeId="e1" />);
    expect(container.querySelector('[data-testid="attendance-grants"]')).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});

describe('approvals inbox — attendance reasons', () => {
  it('proposes the pay effect when rejecting a reason and sends it with the decision', async () => {
    mockGet({});
    apiMock.post.mockResolvedValue({ data: { ...approvalRequest({ status: 'REJECTED' }), noop: false, terminal: true } });
    const request = approvalRequest({ entityType: 'ATTENDANCE_NOTE', context: { kind: 'ATTENDANCE_NOTE', summary: 'Absent', note: { id: 'n1', attendanceDate: '2026-09-20', category: 'absence_reason', note: 'Sick', status: 'pending', dayStatus: 'ABSENT', dayFlags: [], excusedCountYear: 1, payEffectDays: null, lossOfPay: false, infoRequestMessage: null } } });
    renderWithProviders(<DecisionDialog request={request} decision="REJECT" timezone="Asia/Muscat" onClose={vi.fn()} />);
    expect(screen.getByTestId('context-note')).toHaveTextContent('Sick');
    expect(screen.getByRole('radio', { name: 'Full day' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'No deduction' }));
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: 'Needs a certificate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/req-1/decide', { stepNo: 1, decision: 'REJECT', comment: 'Needs a certificate', payEffectDays: 0 }));
  });

  it('the organisation defaults decide the proposed pay effect', () => {
    expect(defaultPayEffect('ABSENT', [], { payEffectAbsent: 0.5 })).toBe(0.5);
    expect(defaultPayEffect('PRESENT', ['LATE'])).toBe(0.5);
    expect(defaultPayEffect('MISSING_PUNCH', [], { payEffectMissingPunch: 1 })).toBe(1);
    expect(defaultPayEffect('PRESENT', [])).toBe(0);
  });
});
