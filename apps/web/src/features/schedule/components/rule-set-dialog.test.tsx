import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/schedule.json';
import ar from '@/locales/ar/schedule.json';
import { RuleSetDialog } from './rule-set-dialog';

registerNamespace('schedule', en, ar);

describe('RuleSetDialog — overtime', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({}); });

  it('starts from "every minute after the shift end" and offers the stricter "beyond the scheduled hours" policy', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'rs1', recalculationJobId: null } });
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={null} />);
    expect(screen.getByLabelText('OT starts after (min)')).toHaveValue(0);
    expect(screen.getByLabelText('Minimum OT block (min)')).toHaveValue(0);
    const strict = screen.getByRole('switch', { name: 'OT only beyond the scheduled hours' });
    expect(strict).not.toBeChecked();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Policy 2026' } });
    fireEvent.click(strict);
    fireEvent.click(screen.getByRole('button', { name: /Create|Save/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/attendance-rule-sets');
    expect(body).toMatchObject({ name: 'Policy 2026', overtimeRequiresScheduledHours: true, overtimeStartAfterMinutes: 0, overtimeMinBlockMinutes: 0, overtimeRoundingMinutes: 0 });
  });
});

describe('RuleSetDialog — the attendance policy editor (Enterprise attendance_policies)', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({}); });
  afterEach(() => { testState.disabledModules = new Set(); });

  it('with the module: the Enterprise sections and scope dimensions are there and the policy sections are sent', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'rs1', recalculationJobId: null } });
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={null} />);
    for (const tab of ['General', 'Late & early', 'Attendance', 'Overtime', 'Discipline', 'Regularisation', 'Ramadan']) expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Employee group/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Country pack/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Weekly overtime after (min)')).toBeInTheDocument();
    // "Auto checkout" is the missing-punch behaviour ASSUME_SHIFT_END
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Behaviour/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Auto checkout at shift end' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Count attendance points' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Office' } });
    fireEvent.click(screen.getByRole('button', { name: /Create|Save/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({ name: 'Office', missingPunchBehavior: 'ASSUME_SHIFT_END', employeeGroupId: null, policy: { points: { enabled: true, late: 1, expiryDays: 90 }, methods: { web: true, requireGeofence: 'inherit' } } });
  });

  it('without the module: the Enterprise sections and fields are hidden and the request carries no policy sections or extra scope', async () => {
    testState.disabledModules = new Set(['attendance_policies']);
    apiMock.post.mockResolvedValue({ data: { id: 'rs1', recalculationJobId: null } });
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={null} />);
    expect(screen.getByRole('tab', { name: 'Overtime' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Discipline' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Regularisation' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Employee group/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Country pack/ })).toBeNull();
    expect(screen.queryByLabelText('Weekly overtime after (min)')).toBeNull();
    expect(screen.queryByText('Very late and repeated late')).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Classic' } });
    fireEvent.click(screen.getByRole('button', { name: /Create|Save/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/attendance-rule-sets');
    expect(body).toMatchObject({ name: 'Classic', graceInMinutes: 10 });
    for (const key of ['policy', 'countryCode', 'departmentId', 'employeeGroupId', 'shiftId']) expect(body).not.toHaveProperty(key);
  });

  it('a country rule pack fills the form, records policy.countryPack, and the compliance warnings show for that country', async () => {
    apiMock.post.mockImplementation((path: string) => path.endsWith('/attendance-policies/compliance')
      ? Promise.resolve({ data: { countryCode: 'OM', packVersion: '2026.10', warnings: [{ code: 'OVERTIME_RATE_BELOW_LAW', severity: 'warning', field: 'policy.overtime.rates.regular', params: { rate: 'regular', value: 1, law: 1.25 } }] } })
      : Promise.resolve({ data: { id: 'rs1', recalculationJobId: null } }));
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={null} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Country pack/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Oman/ }));
    await waitFor(() => expect(screen.getByLabelText('Full day (min)')).toHaveValue(480));
    expect(screen.getByLabelText('Weekly overtime after (min)')).toHaveValue(2400);
    expect(screen.getByLabelText('Statutory daily maximum (min)')).toHaveValue(720);
    // the draft is checked against the Oman pack (debounced) and the warning shows in the panel and under the field
    await waitFor(() => expect(apiMock.post.mock.calls.some(([p]) => String(p).endsWith('/attendance-policies/compliance'))).toBe(true), { timeout: 3000 });
    const [, draft, opts] = apiMock.post.mock.calls.find(([p]) => String(p).endsWith('/attendance-policies/compliance')) as [string, Record<string, unknown>, { query: Record<string, string> }];
    expect(opts.query).toEqual({ countryCode: 'OM' });
    expect(draft).toMatchObject({ countryCode: 'OM', minFullDayMinutes: 480 });
    expect(await screen.findByTestId('compliance-panel')).toHaveTextContent('Compliance with Oman law');
    expect((await screen.findAllByText('Overtime rate ×1 is below the legal minimum ×1.25.')).length).toBeGreaterThanOrEqual(2);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Oman – Office Employees' } });
    fireEvent.click(screen.getByRole('button', { name: /Create|Save/ }));
    await waitFor(() => expect(apiMock.post.mock.calls.some(([p]) => p === '/orgs/org-1/attendance-rule-sets')).toBe(true));
    const [, body] = apiMock.post.mock.calls.find(([p]) => p === '/orgs/org-1/attendance-rule-sets') as [string, Record<string, unknown>];
    expect(body).toMatchObject({ countryCode: 'OM', minFullDayMinutes: 480, overtimeMaxMinutesPerDay: 240, policy: { countryPack: { code: 'OM', version: '2026.10' }, overtime: { weeklyThresholdMinutes: 2400, rates: { regular: 1.25, weeklyOff: 2, holiday: 2 } } } });
  });

  it('editing: the scope is read-only and a PATCH keeps the stored sections', async () => {
    apiMock.patch.mockResolvedValue({ data: { id: 'rs1', recalculationJobId: null } });
    const stored = { id: 'rs1', name: 'Sales', description: 'Sales staff', branchId: null, countryCode: null, departmentId: null, employeeGroupId: 'f0000000-0000-4000-8000-0000000000a1', shiftId: null, effectiveFrom: '2026-01-01', effectiveTo: null, version: 2, specificity: 16, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      graceInMinutes: 5, graceOutMinutes: 0, lateThresholdMinutes: 0, earlyDepartureThresholdMinutes: 0, minFullDayMinutes: 420, halfDayThresholdMinutes: 240, overtimeEnabled: true, overtimeStartAfterMinutes: 0, overtimeMinBlockMinutes: 0, overtimeRoundingMinutes: 0, overtimeMaxMinutesPerDay: null, countEarlyInAsOvertime: false, overtimeRequiresScheduledHours: false,
      punchRoundingMinutes: 0, punchRoundingMode: 'NONE', workedRoundingMinutes: 0, workedRoundingMode: 'NONE', punchInterpretation: 'FIRST_LAST', duplicatePunchWindowSeconds: 60, missingPunchBehavior: 'FLAG_ONLY', autoAbsentWithoutPunches: true, weeklyOffWorkCountsAsOvertime: true, holidayWorkCountsAsOvertime: true, ramadanMode: { enabled: false, appliesTo: 'all' },
      policy: { countryPack: null, late: { veryLateAfterMinutes: 45, repeatedLate: { occurrences: 3, periodDays: 30 } }, methods: { web: true, mobile: false, selfie: true, requireGeofence: 'block' }, overtime: { weeklyThresholdMinutes: null, maxDailyWorkMinutes: null, rates: { regular: 1.25, weekly: 1.25, weeklyOff: 1.5, holiday: 2 } }, points: { enabled: true, late: 1, veryLate: 2, earlyDeparture: 1, absent: 3, missingPunch: 1, unexcused: 2, repeatedLate: 2, expiryDays: 60, escalation: [{ points: 5, action: 'VERBAL_WARNING' }] }, regularisation: { maxPerMonth: 2, backdateDays: null } },
    } as never;
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={stored} />);
    expect(screen.getByRole('combobox', { name: /Employee group/ })).toBeDisabled();
    expect(screen.getByLabelText('Very late after (min from start)')).toHaveValue(45);
    expect(screen.getAllByTestId('escalation-step')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Grace in (min)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/attendance-rule-sets/rs1');
    expect(body).toMatchObject({ graceInMinutes: 12, employeeGroupId: 'f0000000-0000-4000-8000-0000000000a1', description: 'Sales staff', policy: { methods: { mobile: false, requireGeofence: 'block' }, points: { expiryDays: 60, escalation: [{ points: 5, action: 'VERBAL_WARNING' }] }, regularisation: { maxPerMonth: 2 } } });
  });
});
