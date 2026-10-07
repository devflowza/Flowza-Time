import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { RoundTheClockPlanDto } from '@flowza/contracts';
import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { toast } from '@/lib/toast';
import { registerNamespace } from '@/lib/i18n-namespace';
import scheduleEn from '@/locales/en/schedule.json';
import scheduleAr from '@/locales/ar/schedule.json';
import en from '@/locales/en/scheduling.json';
import ar from '@/locales/ar/scheduling.json';
import ShiftsPage from '@/features/schedule/pages/shifts-page';
import { RoundTheClockTab } from './components/round-the-clock-tab';
import { CoverageGrid } from './components/coverage-tab';
import { DeploymentBanner } from './components/deployment-banner';
import DeploymentsPage from './pages/deployments-page';
import { composeDayPreview } from './model';

// the shifts page's own namespace (registered by the schedule routes in the app)
registerNamespace('schedule', scheduleEn, scheduleAr);

const BRANCH_A = 'b0000000-0000-4000-8000-00000000000a';
const BRANCH_B = 'b0000000-0000-4000-8000-00000000000b';
const EMP = 'e0000000-0000-4000-8000-000000000001';
const branch = (id: string, name: string) => ({ id, organizationId: 'org-1', code: name.slice(0, 3).toUpperCase(), name, status: 'active' });

/** The 4-on-4-off plan the API previews (crew offsets folded into the sequences). */
function plan(): RoundTheClockPlanDto {
  const base = ['D', 'D', 'D', 'D', null, null, null, null, 'N', 'N', 'N', 'N', null, null, null, null];
  return {
    template: 'TWO_SHIFT_4ON4OFF',
    shifts: [
      { key: 'D', code: '247-D', name: '24/7 Day', startTime: '06:00', endTime: '18:00', breakMinutes: 60, color: '#F59E0B' },
      { key: 'N', code: '247-N', name: '24/7 Night', startTime: '18:00', endTime: '06:00', breakMinutes: 60, color: '#4338CA' },
    ],
    crews: (['A', 'B', 'C', 'D'] as const).map((crew, k) => ({
      crew, code: `247-${crew}`, name: `24/7 Crew ${crew}`, cycleLengthDays: 16,
      sequence: base.map((_, day) => { const key = base[(((day - k * 4) % 16) + 16) % 16]; return key ? { day, shiftKey: key } : { day, off: true as const }; }),
    })),
    coverageCheck: { covered: true, minCrewsPerShift: 1 },
    averageWeeklyHours: 42,
  };
}

/** Run the "View" action of a sonner toast captured by the spy. */
const clickToastAction = (opts: unknown) => (opts as { action: { onClick: () => void } }).action.onClick();

/** Every key of a nested translation object, dotted. */
const keysOf = (o: Record<string, unknown>, prefix = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));

describe('round-the-clock scheduling (web)', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.disabledModules = new Set(); });
  afterEach(() => { testState.disabledModules = new Set(); vi.restoreAllMocks(); });

  it('has every string in English and Arabic', () => {
    expect(keysOf(ar).sort()).toEqual(keysOf(en).sort());
  });

  it('shows the round-the-clock, coverage and double-shift tabs only while advanced_scheduling is on', async () => {
    mockGet({ '/orgs/org-1/shifts': page([]) });
    testState.disabledModules = new Set(['advanced_scheduling']);
    const off = renderWithProviders(<ShiftsPage />, { route: '/shifts' });
    expect(await screen.findByRole('tab', { name: 'Shifts' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Round-the-clock' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Coverage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Double shifts' })).not.toBeInTheDocument();
    off.unmount();
    testState.disabledModules = new Set();
    renderWithProviders(<ShiftsPage />, { route: '/shifts' });
    expect(await screen.findByRole('tab', { name: 'Round-the-clock' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Coverage' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Double shifts' })).toBeInTheDocument();
  });

  it('previews a template with every crew\'s cycle and creates it, pointing the recalculation at the attendance page (not /sync)', async () => {
    mockGet({ '/orgs/org-1/teams': page([]), '/orgs/org-1/branches': page([branch(BRANCH_A, 'Muscat')]) });
    apiMock.post.mockImplementation(async (path: string) => {
      if (path === '/orgs/org-1/round-the-clock/preview') return { data: plan() };
      if (path === '/orgs/org-1/round-the-clock') return { data: { plan: plan(), shiftIds: ['s1', 's2'], patternIds: ['p1', 'p2', 'p3', 'p4'], assignmentIds: [], coverageIds: [], recalculationJobId: 'queue-77' } };
      throw new Error(`unexpected POST ${path}`);
    });
    const success = vi.spyOn(toast, 'success');
    renderWithProviders(<RoundTheClockTab />, { route: '/shifts?tab=round-the-clock' });
    const grid = await screen.findByRole('table', { name: 'Crew cycles' });
    for (const crew of ['A', 'B', 'C', 'D']) expect(within(grid).getByRole('rowheader', { name: `Crew ${crew}` })).toBeInTheDocument();
    expect(within(grid).getByLabelText('Crew A, day 1: 24/7 Day')).toBeInTheDocument();
    expect(within(grid).getByLabelText('Crew B, day 1: Off')).toBeInTheDocument();
    expect(within(grid).getByLabelText('Crew B, day 5: 24/7 Day')).toBeInTheDocument();
    expect(screen.getByText('Every shift is covered every day')).toBeInTheDocument();
    expect(screen.getByText('42 h a week on average')).toBeInTheDocument();
    expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/round-the-clock/preview', expect.objectContaining({ template: 'TWO_SHIFT_4ON4OFF', codePrefix: '247' }));

    fireEvent.click(screen.getByTestId('rtc-apply'));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/round-the-clock', expect.objectContaining({ template: 'TWO_SHIFT_4ON4OFF', crewTeams: [], coverage: null })));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(2));
    const queued = success.mock.calls.find((c) => (c[1] as { action?: unknown } | undefined)?.action);
    act(() => { clickToastAction(queued![1]); });
    expect(screen.getByTestId('location')).toHaveTextContent('/attendance?tab=recalc');
  });

  it('deploys an employee and links the enrolment toast to its sync job', async () => {
    mockGet({
      '/orgs/org-1/branch-deployments': page([]),
      '/orgs/org-1/branches': page([branch(BRANCH_A, 'Muscat'), branch(BRANCH_B, 'Sohar')]),
      '/orgs/org-1/employees': page([{ id: EMP, displayName: 'Ahmed Hassan', employeeNumber: 'E-1' }]),
    });
    apiMock.post.mockResolvedValue({ data: { id: 'dep-1', employeeId: EMP, employeeName: 'Ahmed Hassan', employeeNumber: 'E-1', homeBranchId: BRANCH_A, homeBranchName: 'Muscat', branchId: BRANCH_B, branchName: 'Sohar', fromDate: '2026-10-07', toDate: '2026-10-09', reason: 'Cover', status: 'active', enrolOnDevices: true, enrolJobId: 'sync-job-1', cleanupJobId: null, cleanedUpAt: null, cancelledAt: null, cancelReason: null, createdAt: '2026-10-07T08:00:00Z' } });
    const success = vi.spyOn(toast, 'success');
    renderWithProviders(<DeploymentsPage />, { route: '/deployments' });
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy employee' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: /^Employee/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Ahmed Hassan/ }));
    fireEvent.click(within(dialog).getByRole('combobox', { name: /^Deploy to branch/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Sohar/ }));
    fireEvent.change(within(dialog).getByLabelText(/^Last day/), { target: { value: '2099-01-02' } });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'Covering the night crew' } });
    fireEvent.click(within(dialog).getByTestId('deployment-save'));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/branch-deployments', expect.objectContaining({ employeeId: EMP, branchId: BRANCH_B, toDate: '2099-01-02', reason: 'Covering the night crew', enrolOnDevices: true })));
    await waitFor(() => expect(success).toHaveBeenCalled());
    const call = success.mock.calls.find((c) => (c[1] as { action?: unknown } | undefined)?.action)!;
    act(() => { clickToastAction(call[1]); });
    expect(screen.getByTestId('location')).toHaveTextContent('/sync/sync-job-1');
  });

  it('the coverage grid shows scheduled / required and highlights a gap', () => {
    renderWithProviders(<CoverageGrid report={{
      branchId: BRANCH_A, from: '2026-09-06', to: '2026-09-07',
      shifts: [{ id: 'm', code: 'MOR', name: 'Morning', startTime: '06:00', endTime: '14:00' }],
      days: [{ date: '2026-09-06', cells: [{ shiftId: 'm', required: 2, scheduled: 2, gap: 0 }] }, { date: '2026-09-07', cells: [{ shiftId: 'm', required: 2, scheduled: 1, gap: 1 }] }],
    }} />);
    expect(screen.getByTestId('cell-2026-09-07-m')).toHaveTextContent('1 / 2');
    expect(screen.getByTestId('cell-2026-09-07-m')).toHaveTextContent('short by 1');
    expect(screen.getByTestId('cell-2026-09-07-m').className).toContain('bg-chart-absent');
    expect(screen.getByTestId('cell-2026-09-06-m').className).not.toContain('bg-chart-absent');
    expect(screen.getByTestId('coverage-gaps')).toHaveTextContent('Shifts short of people: 1');
  });

  it('the portal banner names the host branch and the last day', () => {
    renderWithProviders(<DeploymentBanner deployment={{ branchId: BRANCH_B, branchName: 'Sohar', toDate: '2026-10-09' }} />);
    expect(screen.getByTestId('deployment-banner')).toHaveTextContent('You are deployed to Sohar until 09 Oct 2026.');
  });

  it('describes the composed day of a double shift the way the API combines it', () => {
    const m = { id: 'm', type: 'FIXED', startTime: '06:00', endTime: '14:00' };
    expect(composeDayPreview(m, { id: 'e', type: 'FIXED', startTime: '18:00', endTime: '22:00' })).toEqual({ ok: true, start: '06:00', end: '22:00', gapMinutes: 240, spanMinutes: 960 });
    expect(composeDayPreview(m, { id: 'x', type: 'FIXED', startTime: '10:00', endTime: '16:00' })).toEqual({ ok: false, reason: 'OVERLAP' });
    expect(composeDayPreview(m, { id: 'f', type: 'FLEXIBLE', startTime: null, endTime: null })).toEqual({ ok: false, reason: 'NOT_FIXED' });
    expect(composeDayPreview(m, m)).toEqual({ ok: false, reason: 'SAME_SHIFT' });
  });
});
