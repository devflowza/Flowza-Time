import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { Sidebar } from '@/components/layout/sidebar';
import { RequireModule } from '@/components/layout/protected-route';
import './i18n';
import AdmPlansPage from './pages/plans-page';
import AdmModulesPage from './pages/modules-page';
import { TenantModulesPanel } from './components/tenant-modules-panel';
import SubscriptionSection from '@/features/settings/sections/subscription-section';
import '@/features/settings/routes';

const SETTINGS = { data: { general: { platformName: 'FlowZa Time', supportEmail: 'support@flowza.ai' }, billing: { currency: 'OMR', vatRate: 5, invoicePrefix: 'FZT', paymentTermsDays: 14, sellerName: 'F & Z Capital', sellerVatNumber: '', sellerAddress: 'Muscat', bankDetails: '' }, updatedAt: null } };
const ALL_MODULES = ['devices', 'finance_integration', 'geofences', 'leave', 'manager_workspace', 'payroll', 'report_schedules', 'self_service'];
const plan = (key: string, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-0000-0000-00000000000${key.length}`, key, name: key[0]!.toUpperCase() + key.slice(1), description: null, prices: {}, limits: { employees: 50 }, features: [],
  modules: ALL_MODULES, includedUsers: null, trialDays: 0, isCustom: false, isActive: true, sortOrder: 1, subscribers: 0, liveSubscribers: 0, ...over,
});
const PROFESSIONAL = plan('professional', { includedUsers: 11, prices: { OMR: { monthly: 50, yearly: 500, extraUserMonthly: 4, extraUserYearly: 40 } }, modules: ALL_MODULES.filter((m) => m !== 'finance_integration'), liveSubscribers: 3, subscribers: 4 });

beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.employeeId = null; });
afterEach(() => { testState.disabledModules = new Set(); testState.employeeId = null; });

describe('tenant module gating (web)', () => {
  it('hides the navigation of modules that are off, and only those', () => {
    testState.employeeId = 'e1';
    testState.disabledModules = new Set(['leave', 'devices', 'payroll']);
    renderWithProviders(<Sidebar />);
    for (const name of ['Leave', 'Devices', 'Sync jobs', 'Payroll', 'Punch log']) expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /my leave/i })).not.toBeInTheDocument();
    for (const name of ['Employees', 'Attendance', 'Reports', 'Shifts']) expect(screen.getByRole('link', { name })).toBeInTheDocument();
  });

  it('a page of a module that is off explains it instead of rendering', () => {
    testState.disabledModules = new Set(['payroll']);
    renderWithProviders(<RequireModule modules={['payroll']}><p>payroll screen</p></RequireModule>);
    expect(screen.queryByText('payroll screen')).not.toBeInTheDocument();
    expect(screen.getByText('Payroll is not part of your subscription')).toBeInTheDocument();
  });
});

describe('Plans & pricing', () => {
  it('shows the reference package (Professional, 500 OMR a year for 11 users) and prices a quote with VAT', async () => {
    mockGet({ '/platform/plans': { data: [plan('trial', { trialDays: 14 }), PROFESSIONAL, plan('enterprise', { isCustom: true })] }, '/platform/settings': SETTINGS });
    renderWithProviders(<AdmPlansPage />);
    const card = await screen.findByTestId('plan-professional');
    expect(within(card).getByText(/OMR\s500\.000/)).toBeInTheDocument();
    expect(within(card).getByText('Includes 11 users')).toBeInTheDocument();
    expect(within(screen.getByTestId('plan-enterprise')).getByText('Contact sales')).toBeInTheDocument();
    const calc = screen.getByTestId('calculator-result');
    expect(within(calc).getByText(/OMR\s525\.000/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Users'), { target: { value: '20' } });
    // 500 + 9 × 40 = 860, + 5% VAT = 903
    await waitFor(() => expect(within(screen.getByTestId('calculator-result')).getByText(/OMR\s903\.000/)).toBeInTheDocument());
  });
});

describe('Modules', () => {
  it('switching a module off fleet-wide asks for a reason and PATCHes it', async () => {
    mockGet({ '/platform/modules': { data: [{ key: 'leave', name: 'Leave management', description: '', category: 'workforce', sortOrder: 40, isAvailable: true, enabledCount: 4, totalOrganizations: 5, overrideOnCount: 0, overrideOffCount: 1, planKeys: ['professional'], updatedAt: '2026-09-29T00:00:00Z' }] } });
    apiMock.patch.mockResolvedValue({ data: {} });
    renderWithProviders(<AdmModulesPage />);
    const card = await screen.findByTestId('module-leave');
    expect(within(card).getByText('1 forced off')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('switch'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Leave is being reworked' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/platform/modules/leave', { isAvailable: false, reason: 'Leave is being reworked' }));
  });

  it("a tenant's module switch records an override with its reason", async () => {
    mockGet({ '/platform/orgs/org-9/modules': { data: [{ key: 'leave', name: 'Leave management', description: '', category: 'workforce', enabled: true, inPlan: true, override: null, available: true, lapsed: false, reason: null, updatedAt: null }] } });
    apiMock.put.mockResolvedValue({ data: [] });
    renderWithProviders(<TenantModulesPanel orgId="org-9" />);
    const row = await screen.findByTestId('tenant-module-leave');
    fireEvent.click(within(row).getByRole('switch'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Customer does not use leave' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/platform/orgs/org-9/modules', { modules: { leave: false }, reason: 'Customer does not use leave' }));
  });
});

describe('tenant Settings → Subscription', () => {
  it('shows the plan, its price excl. VAT, the modules it includes and the plans to compare', async () => {
    mockGet({
      '/orgs/org-1/subscription': { data: {
        planKey: 'professional', planName: 'Professional', status: 'active', trialEndsAt: null, currentPeriodStart: null, currentPeriodEnd: '2027-09-30T19:59:59.999Z', cancelAt: null,
        billingCycle: 'yearly', seats: 11, includedUsers: 11, isCustom: false, vatRate: 5,
        price: { currency: 'OMR', cycle: 'yearly', seats: 11, includedUsers: 11, extraUsers: 0, base: 500, extraUnit: 40, extraAmount: 0, amount: 500, monthlyEquivalent: 41.667, perUserMonthly: 3.788 },
        limits: { employees: 11, devices: 5 }, usage: { employees: 9, devices: 1 }, features: [],
        modules: [{ key: 'leave', name: 'Leave management', description: '', category: 'workforce', enabled: true, inPlan: true, override: null, available: true, lapsed: false, reason: null, updatedAt: null },
          { key: 'finance_integration', name: 'Flowza Finance integration', description: '', category: 'integrations', enabled: false, inPlan: false, override: null, available: true, lapsed: false, reason: null, updatedAt: null }],
        availablePlans: [{ key: 'professional', name: 'Professional', description: null, includedUsers: 11, isCustom: false, modules: ['leave'], prices: PROFESSIONAL.prices }],
        billingContact: { supportEmail: 'support@flowza.ai', sellerName: 'F & Z Capital', bankDetails: 'Bank Muscat', currency: 'OMR' },
      } },
      '/orgs/org-1/billing/invoices': { data: [] },
    });
    renderWithProviders(<SubscriptionSection />);
    expect(await screen.findByTestId('subscription-price')).toHaveTextContent(/OMR\s500\.000/);
    expect(screen.getByTestId('usage-employees')).toHaveTextContent('9 / 11');
    expect(screen.getByTestId('module-finance_integration')).toHaveTextContent('Not part of your subscription');
    expect(screen.getByTestId('plan-professional')).toHaveTextContent('Current');
    expect(screen.getByText('Bank Muscat')).toBeInTheDocument();
  });
});
