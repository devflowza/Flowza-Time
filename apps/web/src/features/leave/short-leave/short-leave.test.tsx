import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() }, toastError: vi.fn(), toastQueued: vi.fn() }));

import type { SelfTimeOffDto, TimeOffRequestDto, TimeOffTypeDto } from '@flowza/contracts';
import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { toast } from '@/lib/toast';
import { checkWindow, fmtDuration } from './model';
import { TimeOffTypesTab } from './components/types-tab';
import { SelfShortLeaveSection } from './components/self-section';
import enLocale from '@/locales/en/short-leave.json';
import arLocale from '@/locales/ar/short-leave.json';

/**
 * Short leave in the web: the types tab (list, seed, create with the category's default for "counts as work"), the portal section
 * (requests with their status, the request form's live checks — a backwards window, the per-request limit, the month's quota —
 * and withdrawing with a reason) and the en / ar parity of the namespace.
 */
const PERSONAL = '11111111-1111-4111-8111-111111111111';
const OFFICIAL = '22222222-2222-4222-8222-222222222222';
const type = (over: Partial<TimeOffTypeDto> = {}): TimeOffTypeDto => ({
  id: PERSONAL, code: 'PERSONAL', name: 'Personal permission', nameAr: 'استئذان شخصي', category: 'PERSONAL', countsAsWork: false, maxMinutesPerRequest: 120, monthlyQuotaMinutes: 240, monthlyQuotaCount: null,
  requiresApproval: true, applicableGender: 'all', portalVisible: true, status: 'active', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over,
});
const request = (over: Partial<TimeOffRequestDto> = {}): TimeOffRequestDto => ({
  id: 'r1', employeeId: 'e1', employeeName: 'Salim', employeeNumber: 'E-1', branchId: null, typeId: PERSONAL, typeCode: 'PERSONAL', typeName: 'Personal permission', typeNameAr: null, category: 'PERSONAL', countsAsWork: false,
  date: '2026-10-12', startTime: '08:00', endTime: '10:00', minutes: 120, reason: 'Doctor appointment', status: 'PENDING', decisionNote: null, decidedAt: null, cancelledAt: null, cancelReason: null,
  approvalRequestId: 'req-1', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1, infoRequested: false, recordedByHr: false, createdBy: 'u1', createdAt: '2026-10-10T06:00:00Z', updatedAt: '2026-10-10T06:00:00Z', canWithdraw: true, ...over,
});

beforeEach(() => {
  resetApiMock(); grantAll();
  vi.mocked(toast.success).mockReset();
});

describe('model', () => {
  it('formats durations and checks a window against the type and the quota', () => {
    expect(fmtDuration(90)).toBe('1:30');
    expect(checkWindow('10:00', '09:00', { maxMinutesPerRequest: null, quotaMinutes: null, usedMinutes: 0 })).toMatchObject({ minutes: null, error: 'window' });
    expect(checkWindow('08:00', '11:00', { maxMinutesPerRequest: 120, quotaMinutes: null, usedMinutes: 0 })).toMatchObject({ minutes: 180, error: 'max' });
    expect(checkWindow('08:00', '09:30', { maxMinutesPerRequest: 120, quotaMinutes: 240, usedMinutes: 180 })).toMatchObject({ minutes: 90, error: 'quota', remaining: 60 });
    expect(checkWindow('22:00', '24:00', { maxMinutesPerRequest: null, quotaMinutes: null, usedMinutes: 0 })).toMatchObject({ minutes: 120, error: null });
  });

  it('has the same keys and interpolation variables in English and Arabic', () => {
    type Tree = { [k: string]: string | Tree };
    const flat = (t: Tree, p = ''): Record<string, string> => Object.entries(t).reduce<Record<string, string>>((a, [k, v]) => (typeof v === 'string' ? { ...a, [`${p}${k}`]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
    const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
    const en = flat(enLocale as Tree); const ar = flat(arLocale as Tree);
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) expect([k, vars(ar[k] ?? '')]).toEqual([k, vars(en[k]!)]);
  });
});

describe('short leave types tab', () => {
  it('lists the types with their rules and seeds the default set', async () => {
    mockGet({ '/orgs/org-1/time-off-types': { data: [type(), type({ id: OFFICIAL, code: 'OFFICIAL', name: 'Official assignment', category: 'OFFICIAL', countsAsWork: true, maxMinutesPerRequest: null, monthlyQuotaMinutes: null, portalVisible: false })] } });
    apiMock.post.mockResolvedValue({ data: { created: ['REMOTE'], types: [] } });
    renderWithProviders(<TimeOffTypesTab />);
    const row = await screen.findByTestId('time-off-type-PERSONAL');
    expect(within(row).getByText('≤ 2:00 per request')).toBeInTheDocument();
    expect(within(row).getByText('4:00 / month')).toBeInTheDocument();
    const official = screen.getByTestId('time-off-type-OFFICIAL');
    expect(within(official).getByText('Counts as work')).toBeInTheDocument();
    expect(within(official).getByText('HR only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add the default types/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/time-off-types/seed-defaults'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Default types added: 1'));
  });

  it('creates a type: an official assignment counts as work by default', async () => {
    mockGet({ '/orgs/org-1/time-off-types': { data: [] } });
    apiMock.post.mockResolvedValue({ data: type({ code: 'MISSION', category: 'OFFICIAL', countsAsWork: true }) });
    renderWithProviders(<TimeOffTypesTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Add type/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Code/), { target: { value: 'MISSION' } });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Ministry mission' } });
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: /Category/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Official assignment' }));
    fireEvent.change(within(dialog).getByLabelText(/Monthly quota \(requests\)/), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Create/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/time-off-types', expect.objectContaining({ code: 'MISSION', name: 'Ministry mission', category: 'OFFICIAL', countsAsWork: true, monthlyQuotaCount: 4, requiresApproval: true })));
  });

  it('hides the management buttons without leave.manage', async () => {
    grant('leave.view');
    mockGet({ '/orgs/org-1/time-off-types': { data: [type()] } });
    renderWithProviders(<TimeOffTypesTab />);
    await screen.findByTestId('time-off-type-PERSONAL');
    expect(screen.queryByRole('button', { name: /Add type/ })).not.toBeInTheDocument();
  });
});

describe('portal short leave', () => {
  const self = (over: Partial<SelfTimeOffDto> = {}): SelfTimeOffDto => ({
    month: '2026-10', types: [type(), type({ id: OFFICIAL, code: 'OFFICIAL', name: 'Official assignment', category: 'OFFICIAL', countsAsWork: true, maxMinutesPerRequest: null, monthlyQuotaMinutes: null })],
    usage: [{ typeId: PERSONAL, month: '2026-10', usedMinutes: 180, usedCount: 2, quotaMinutes: 240, quotaCount: null }, { typeId: OFFICIAL, month: '2026-10', usedMinutes: 0, usedCount: 0, quotaMinutes: null, quotaCount: null }],
    requests: [request(), request({ id: 'r2', status: 'APPROVED', canWithdraw: false, startTime: '13:00', endTime: '14:00', minutes: 60 })],
    allowances: [{ id: 'a1', employeeId: 'e1', kind: 'NURSING', minutesPerDay: 60, position: 'START', validFrom: '2026-09-01', validTo: '2027-03-01', reference: null, notes: null, createdAt: '', updatedAt: '', active: true }],
    ...over,
  });

  it('lists the month\'s requests, the quota use and the reduced hours; withdraws a pending one with a reason', async () => {
    mockGet({ '/orgs/org-1/me/time-off': { data: self() } });
    apiMock.post.mockResolvedValue({ data: request({ status: 'CANCELLED', canWithdraw: false }) });
    renderWithProviders(<SelfShortLeaveSection />);
    expect(await screen.findByTestId('short-leave-row-r1')).toBeInTheDocument();
    expect(screen.getByText(/Personal permission: 3:00 of 4:00 used this month/)).toBeInTheDocument();
    expect(screen.getByText(/Nursing hour · 1:00 a day \(Later start\)/)).toBeInTheDocument();
    // only the pending request can be withdrawn
    const approved = screen.getByTestId('short-leave-row-r2');
    expect(within(approved).queryByRole('button', { name: /Withdraw/ })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('short-leave-row-r1')).getByRole('button', { name: /Withdraw/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Not needed any more' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Withdraw/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/me/time-off/r1/withdraw', { reason: 'Not needed any more' }));
  });

  it('the request form shows the length, refuses what the type or the quota does not allow, and submits a valid window', async () => {
    mockGet({ '/orgs/org-1/me/time-off': { data: self() } });
    apiMock.post.mockResolvedValue({ data: { ...request({ id: 'r3' }), recalculationJobId: null } });
    renderWithProviders(<SelfShortLeaveSection />);
    await screen.findByTestId('short-leave-row-r1');
    fireEvent.click(screen.getByRole('button', { name: /Request short leave/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Date/), { target: { value: '2026-10-20' } });
    fireEvent.change(within(dialog).getByLabelText(/^From/), { target: { value: '08:00' } });
    fireEvent.change(within(dialog).getByLabelText(/^To/), { target: { value: '11:00' } });
    // 3 h > the type's 2 h per request
    expect(await within(dialog).findByText('At most 2:00 for this type')).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: /Request short leave/ });
    expect(submit).toBeDisabled();
    // 1:30 fits the request limit but not the hour the month's quota leaves
    fireEvent.change(within(dialog).getByLabelText(/^To/), { target: { value: '09:30' } });
    expect(await within(dialog).findByText("This month's quota leaves 1:00")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^To/), { target: { value: '09:00' } });
    await waitFor(() => expect(within(dialog).getByTestId('short-leave-summary')).toHaveTextContent('1:00'));
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'Bank appointment' } });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/me/time-off', { typeId: PERSONAL, date: '2026-10-20', startTime: '08:00', endTime: '09:00', reason: 'Bank appointment' }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Short leave requested'));
  });
});
