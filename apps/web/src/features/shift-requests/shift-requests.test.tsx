import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { ApprovalContextDto, ShiftChangeRequestDto } from '@flowza/contracts';
import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import MyShiftPage from '@/features/portal/pages/shift-page';
import MyRequestsPage from '@/features/portal/pages/requests-page';
import ShiftsPage from '@/features/schedule/pages/shifts-page';
import { ApprovalContext } from '@/features/approvals/components/parts';
import { registerNamespace } from '@/lib/i18n-namespace';
import enLocale from '@/locales/en/shift-requests.json';
import arLocale from '@/locales/ar/shift-requests.json';
import enSchedule from '@/locales/en/schedule.json';
import arSchedule from '@/locales/ar/schedule.json';

registerNamespace('schedule', enSchedule, arSchedule);

/*
 * Enterprise shift change requests on the web (module shift_requests): the portal hides swaps and changes when the module is off
 * (no 403 from the page), the change dialog files a request, the approvals inbox renders the request, the Shifts page has the
 * HR tab only with the module and attendance.view.
 */
const ORG = 'org-1';
const EMP = '11111111-1111-4111-8111-111111111111';
const shift = { id: 's1', code: 'MORN', name: 'Morning', type: 'FIXED' as const, startTime: '06:00', endTime: '14:00', requiredMinutes: null, graceInMinutes: 10, crossesMidnight: false, color: '#175cd3', breakMinutes: 0 };
const day = (date: string, over = {}) => ({ date, shift, source: 'ASSIGNMENT' as const, isOff: false, holidayName: null, onLeave: false, swap: null, ...over });
const myShift = { date: '2026-09-27', timezone: 'Asia/Muscat', today: day('2026-09-27'), upcoming: [day('2026-09-28'), day('2026-09-29'), day('2026-09-30')], history: [] };
const change = (over: Partial<ShiftChangeRequestDto> = {}): ShiftChangeRequestDto => ({
  id: 'c1', kind: 'CHANGE', status: 'pending', employeeId: EMP, employeeName: 'Sara Nasser', employeeNumber: 'A-001', branchId: null, fromDate: '2026-09-29', toDate: '2026-09-30',
  requestedShift: { id: 's2', code: 'DAY', name: 'Day', startTime: '08:00', endTime: '16:00' }, currentShift: { id: 's1', code: 'MORN', name: 'Morning' }, reason: 'Childcare in the mornings', mine: true,
  approvalRequestId: 'req-1', approvalStatus: 'PENDING', appliedAssignmentIds: [], decidedAt: null, decisionNote: null, createdAt: '2026-09-27T05:00:00Z', updatedAt: '2026-09-27T05:00:00Z', ...over,
});
const options = {
  date: '2026-09-27', current: { date: '2026-09-27', shift, source: 'ASSIGNMENT', isOff: false, holidayName: null, onLeave: false },
  shifts: [
    { id: 's1', code: 'MORN', name: 'Morning', nameAr: null, type: 'FIXED', startTime: '06:00', endTime: '14:00', crossesMidnight: false, color: null },
    { id: 's2', code: 'DAY', name: 'Day', nameAr: null, type: 'FIXED', startTime: '08:00', endTime: '16:00', crossesMidnight: false, color: null },
    { id: 's3', code: 'EVE', name: 'Evening', nameAr: null, type: 'FIXED', startTime: '18:00', endTime: '22:00', crossesMidnight: false, color: null },
    { id: 's4', code: 'FLEX', name: 'Flexi', nameAr: null, type: 'FLEXIBLE', startTime: null, endTime: null, crossesMidnight: false, color: null },
  ],
};

function mockPortal(changes: ShiftChangeRequestDto[] = []) {
  mockGet({
    [`/orgs/${ORG}/me/shift`]: { data: myShift },
    [`/orgs/${ORG}/me/shift-swaps`]: { data: [] },
    [`/orgs/${ORG}/me/shift-changes`]: { data: changes },
    [`/orgs/${ORG}/me/shift-changes/options`]: { data: options },
  });
}
const calledPaths = () => apiMock.get.mock.calls.map((c) => String(c[0]));
/** The page's buttons are enabled once the schedule has loaded. */
async function openChangeDialog() {
  const button = await screen.findByRole('button', { name: /Request a shift change/ });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.findByRole('dialog');
}
/** Radix Select in jsdom (AGENTS.md): open with ArrowDown on the trigger, pick with a click. */
async function pick(trigger: HTMLElement, option: RegExp) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = ORG; testState.employeeId = EMP; testState.disabledModules = new Set(); });
afterEach(() => { testState.disabledModules = new Set(); testState.employeeId = null; vi.restoreAllMocks(); });

describe('portal: My shift', () => {
  it('without the module: no swap or change button, no request tables, and the request endpoints are never called', async () => {
    testState.disabledModules = new Set(['shift_requests']);
    mockPortal();
    renderWithProviders(<MyShiftPage />);
    expect(await screen.findAllByText('Morning 06:00–14:00')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Request a swap/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Request a shift change/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Shift swaps')).not.toBeInTheDocument();
    expect(screen.queryByText('My shift change requests')).not.toBeInTheDocument();
    expect(calledPaths().some((p) => p.includes('/me/shift-swaps') || p.includes('/me/shift-changes'))).toBe(false);
  });

  it('without the module the requests page offers no swaps tab', async () => {
    testState.disabledModules = new Set(['shift_requests']);
    mockGet({ [`/orgs/${ORG}/me/attendance/notes`]: { data: [] } });
    renderWithProviders(<MyRequestsPage />, { route: '/my/requests?tab=swaps' });
    expect(await screen.findByRole('tab', { name: 'Reasons' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Shift swaps' })).not.toBeInTheDocument();
    expect(calledPaths().some((p) => p.includes('/me/shift-swaps'))).toBe(false);
  });

  it('lists the requests, marks the days a pending change covers, and files a change', async () => {
    mockPortal([change()]);
    apiMock.post.mockResolvedValue({ data: change({ id: 'c2' }) });
    renderWithProviders(<MyShiftPage />);
    const row = await screen.findByTestId('shift-change-row');
    expect(row).toHaveTextContent('Change of shift');
    expect(row).toHaveTextContent('Morning → Day');
    expect(row).toHaveTextContent('Pending');
    expect(within(row).getByRole('button', { name: /Withdraw/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('shift-change-badge')).toHaveLength(2); // 29 and 30 Sep
    expect(screen.getByRole('button', { name: /Request a swap/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Request a shift change/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('sc-current')).toHaveTextContent('Morning 06:00–14:00');
    fireEvent.change(within(dialog).getByLabelText(/Last day/), { target: { value: '2026-09-29' } });
    await pick(within(dialog).getByRole('combobox', { name: /^Shift/ }), /Evening/);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Childcare' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/shift-changes`, { kind: 'CHANGE', fromDate: '2026-09-27', toDate: '2026-09-29', shiftId: 's3', reason: 'Childcare' }));
  });

  it('checks the form before sending: a range longer than allowed and a missing shift', async () => {
    mockPortal();
    renderWithProviders(<MyShiftPage />);
    const dialog = await openChangeDialog();
    fireEvent.change(within(dialog).getByLabelText(/Last day/), { target: { value: '2027-01-15' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByText('One request covers at most 92 days.')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose a shift.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('an additional (double) shift is offered only with round-the-clock scheduling, and only fixed shifts', async () => {
    mockPortal();
    apiMock.post.mockResolvedValue({ data: change({ kind: 'ADDITIONAL' }) });
    const view = renderWithProviders(<MyShiftPage />);
    let dialog = await openChangeDialog();
    await pick(within(dialog).getByRole('combobox', { name: /^Request/ }), /Additional shift/);
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: /^Shift/ }), { key: 'ArrowDown' });
    expect(await screen.findByRole('option', { name: /Evening/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Flexi/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Evening/ }));
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Extra hours' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/${ORG}/me/shift-changes`, expect.objectContaining({ kind: 'ADDITIONAL', shiftId: 's3' })));
    view.unmount();

    testState.disabledModules = new Set(['advanced_scheduling']);
    renderWithProviders(<MyShiftPage />);
    dialog = await openChangeDialog();
    expect(within(dialog).queryByRole('combobox', { name: /^Request/ })).not.toBeInTheDocument();
  });
});

describe('approvals inbox context', () => {
  const context = (over: Partial<Extract<ApprovalContextDto, { kind: 'SHIFT_CHANGE' }>['change']> = {}): ApprovalContextDto => ({
    kind: 'SHIFT_CHANGE', summary: 'x',
    change: { id: 'c1', kind: 'CHANGE', fromDate: '2026-10-12', toDate: '2026-10-14', employeeName: 'Sara Nasser', requestedShiftName: 'Day', currentShiftName: 'Morning', reason: 'Childcare in the mornings', status: 'pending', ...over },
  });
  it('shows the kind, the range, the shifts and the reason', () => {
    renderWithProviders(<ApprovalContext context={context()} timezone="Asia/Muscat" />);
    const el = screen.getByTestId('context-shift-change');
    expect(el).toHaveTextContent('Change of shift');
    expect(el).toHaveTextContent('12 Oct 2026 → 14 Oct 2026');
    expect(el).toHaveTextContent('Morning → Day');
    expect(el).toHaveTextContent('Childcare in the mornings');
  });
  it('an additional shift says what is added', () => {
    renderWithProviders(<ApprovalContext context={context({ kind: 'ADDITIONAL', requestedShiftName: 'Evening', toDate: '2026-10-12' })} timezone="Asia/Muscat" />);
    const el = screen.getByTestId('context-shift-change');
    expect(el).toHaveTextContent('Additional shift');
    expect(el).toHaveTextContent('Adds Evening');
    expect(el).toHaveTextContent('12 Oct 2026');
    expect(el).not.toHaveTextContent('→');
  });
});

describe('Shifts page: the HR tab', () => {
  const hrMocks = () => mockGet({
    [`/orgs/${ORG}/shift-change-requests`]: page([change({ mine: false, employeeName: 'Sara Nasser' }), change({ id: 'c2', kind: 'ADDITIONAL', status: 'approved', approvalStatus: 'APPROVED', requestedShift: { id: 's3', code: 'EVE', name: 'Evening', startTime: '18:00', endTime: '22:00' }, approvalRequestId: 'req-2', mine: false })]),
    [`/orgs/${ORG}/employees`]: page([]), [`/orgs/${ORG}/branches`]: page([]),
  });

  it('lists the requests with a link to each one in the approvals inbox', async () => {
    hrMocks();
    renderWithProviders(<ShiftsPage />, { route: '/shifts?tab=requests' });
    expect(await screen.findByRole('tab', { name: 'Shift requests' })).toHaveAttribute('aria-selected', 'true');
    expect((await screen.findAllByText('Sara Nasser')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('+ Evening').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /Open in approvals/ }).map((a) => a.getAttribute('href'))).toEqual(expect.arrayContaining(['/approvals/requests/req-1', '/approvals/requests/req-2']));
    expect(screen.getByRole('link', { name: /Open approvals/ })).toHaveAttribute('href', '/approvals');
    expect(apiMock.get).toHaveBeenCalledWith(`/orgs/${ORG}/shift-change-requests`, expect.objectContaining({ page: 1 }));
  });

  it('no tab without the module or without attendance.view', async () => {
    hrMocks();
    testState.disabledModules = new Set(['shift_requests']);
    const view = renderWithProviders(<ShiftsPage />, { route: '/shifts?tab=requests' });
    expect(await screen.findByRole('tab', { name: 'Shifts' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Shift requests' })).not.toBeInTheDocument();
    view.unmount();
    testState.disabledModules = new Set();
    grant('shift.view');
    renderWithProviders(<ShiftsPage />);
    expect(await screen.findByRole('tab', { name: 'Shifts' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Shift requests' })).not.toBeInTheDocument();
    expect(calledPaths().some((p) => p.includes('/shift-change-requests'))).toBe(false);
  });
});

describe('locale parity', () => {
  type Tree = { [k: string]: string | Tree };
  const flatten = (t: Tree, prefix = ''): Record<string, string> => Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === 'string' ? { ...acc, [`${prefix}${k}`]: v } : { ...acc, ...flatten(v, `${prefix}${k}.`) }), {});
  const vars = (s: string) => [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))].sort();
  it('every English string exists in Arabic with the same variables', () => {
    const en = flatten(enLocale as Tree); const ar = flatten(arLocale as Tree);
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(en)) expect([k, vars(ar[k] ?? '')]).toEqual([k, vars(v)]);
  });
});
