/**
 * Modules, plans & pricing, billing and platform settings (migration 20260929000600): the super-admin portal's Modules,
 * Plans & Pricing, Billing and Settings pages and the tenant's Subscription view. Authorisation of every /platform route
 * for non-platform-admins is proven generically by route-authz.test.ts (e); this file proves behaviour: what a module switch
 * closes (and only for that tenant), the plan / override / fleet switch / lapse rule, the reference price (500 OMR a year for
 * 11 users), invoices, payments, refunds and the subscription activation of a paid invoice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, F, type TestApi } from './harness.js';

let api: TestApi;
beforeAll(async () => { api = await createTestApi('modbilling'); }, 120_000);
afterAll(async () => { await api?.close(); });

const asAdmin = { user: F.platformAdmin };
const modulesOf = async (user: string, orgId: string) => {
  const me = await api.request('GET', '/me', { user });
  return me.json.data.memberships.find((m: { organization: { id: string } }) => m.organization.id === orgId) as { modules: Record<string, boolean>; subscriptionLapsed: boolean };
};

describe('module switches', () => {
  it('every tenant that exists today keeps every module (trial and business include them all)', async () => {
    const a = await modulesOf(F.ownerA, F.orgA);
    expect(Object.values(a.modules).every(Boolean)).toBe(true);
    expect(Object.keys(a.modules).sort()).toEqual(['devices', 'finance_integration', 'geofences', 'leave', 'manager_workspace', 'payroll', 'report_schedules', 'self_service']);
    const b = await modulesOf(F.ownerB, F.orgB);
    expect(Object.values(b.modules).every(Boolean)).toBe(true);
    expect(b.subscriptionLapsed).toBe(false);
    expect((await api.request('GET', `/orgs/${F.orgA}/leave-types`, { user: F.ownerA })).status).toBe(200);
  });

  it('a platform admin switches Leave off for one tenant: its leave routes answer 403 MODULE_DISABLED, the other tenant is untouched', async () => {
    const put = await api.request('PUT', `/platform/orgs/${F.orgA}/modules`, { ...asAdmin, body: { modules: { leave: false }, reason: 'Customer does not use leave' } });
    expect(put.status).toBe(200);
    expect(put.json.data.find((m: { key: string }) => m.key === 'leave')).toMatchObject({ enabled: false, inPlan: true, override: false, reason: 'Customer does not use leave' });
    for (const path of ['leave-types', 'leave-records', 'leave-balances', 'me/leave']) {
      const res = await api.request('GET', `/orgs/${F.orgA}/${path}`, { user: F.ownerA });
      expect(res.status, path).toBe(403);
      expect(res.json).toMatchObject({ code: 'FEATURE_DISABLED', details: { reason: 'MODULE_DISABLED', module: 'leave' } });
    }
    // the core stays open
    expect((await api.request('GET', `/orgs/${F.orgA}/employees`, { user: F.ownerA })).status).toBe(200);
    expect((await api.request('GET', `/orgs/${F.orgA}/shifts`, { user: F.ownerA })).status).toBe(200);
    expect((await modulesOf(F.ownerA, F.orgA)).modules.leave).toBe(false);
    // org B keeps leave
    expect((await api.request('GET', `/orgs/${F.orgB}/leave-types`, { user: F.ownerB })).status).toBe(200);
    // the tenant sees what the platform changed
    const log = await api.request('GET', `/orgs/${F.orgA}/audit?action=organization.modules_changed`, { user: F.ownerA });
    expect(log.status).toBe(200);
    expect(log.json.data[0]).toMatchObject({ action: 'organization.modules_changed', actorType: 'PLATFORM_ADMIN', reason: 'Customer does not use leave' });
  });

  it('back to the plan (null) reopens the module', async () => {
    const put = await api.request('PUT', `/platform/orgs/${F.orgA}/modules`, { ...asAdmin, body: { modules: { leave: null }, reason: 'Customer asked for leave again' } });
    expect(put.json.data.find((m: { key: string }) => m.key === 'leave')).toMatchObject({ enabled: true, override: null });
    expect((await api.request('GET', `/orgs/${F.orgA}/leave-types`, { user: F.ownerA })).status).toBe(200);
  });

  it('the plan decides when there is no override; an override can grant a module the plan lacks', async () => {
    const sub = await api.request('PATCH', `/platform/orgs/${F.orgB}/subscription`, { ...asAdmin, body: { planKey: 'starter', status: 'active', reason: 'Starter package' } });
    expect(sub.status).toBe(200);
    const b = await modulesOf(F.ownerB, F.orgB);
    expect(b.modules).toMatchObject({ devices: true, self_service: true, leave: false, geofences: false, payroll: false, manager_workspace: false, report_schedules: false, finance_integration: false });
    expect((await api.request('GET', `/orgs/${F.orgB}/geofences`, { user: F.ownerB })).status).toBe(403);
    expect((await api.request('GET', `/orgs/${F.orgB}/payroll/periods`, { user: F.ownerB })).status).toBe(403);
    expect((await api.request('GET', `/orgs/${F.orgB}/devices`, { user: F.ownerB })).status).toBe(200);
    await api.request('PUT', `/platform/orgs/${F.orgB}/modules`, { ...asAdmin, body: { modules: { payroll: true }, reason: 'Complimentary payroll' } });
    expect((await api.request('GET', `/orgs/${F.orgB}/payroll/periods`, { user: F.ownerB })).status).not.toBe(403);
    await api.request('PUT', `/platform/orgs/${F.orgB}/modules`, { ...asAdmin, body: { modules: { payroll: null }, reason: 'End of complimentary payroll' } });
  });

  it('the fleet-wide switch turns a module off for every tenant, whatever its plan or override', async () => {
    const off = await api.request('PATCH', '/platform/modules/payroll', { ...asAdmin, body: { isAvailable: false, reason: 'Maintenance of payroll exports' } });
    expect(off.status).toBe(200);
    expect(off.json.data).toMatchObject({ key: 'payroll', isAvailable: false, enabledCount: 0 });
    expect((await api.request('GET', `/orgs/${F.orgA}/payroll/periods`, { user: F.ownerA })).status).toBe(403);
    await api.request('PATCH', '/platform/modules/payroll', { ...asAdmin, body: { isAvailable: true, reason: 'Payroll exports back' } });
    expect((await api.request('GET', `/orgs/${F.orgA}/payroll/periods`, { user: F.ownerA })).status).not.toBe(403);
  });

  it('lists modules with adoption and applies one module to every tenant', async () => {
    const list = await api.request('GET', '/platform/modules', asAdmin);
    expect(list.status).toBe(200);
    const devices = list.json.data.find((m: { key: string }) => m.key === 'devices');
    expect(devices).toMatchObject({ isAvailable: true, planKeys: expect.arrayContaining(['starter', 'professional', 'business']) });
    expect(devices.enabledCount).toBe(devices.totalOrganizations);
    const all = await api.request('POST', '/platform/modules/manager_workspace/apply-all', { ...asAdmin, body: { action: 'disable', reason: 'Pilot of the new workspace' } });
    expect(all.json.data).toMatchObject({ key: 'manager_workspace', action: 'disable', organizations: 2 });
    expect((await api.request('GET', `/orgs/${F.orgA}/team/summary`, { user: F.ownerA })).status).toBe(403);
    const reset = await api.request('POST', '/platform/modules/manager_workspace/apply-all', { ...asAdmin, body: { action: 'reset', reason: 'Pilot over' } });
    expect(reset.json.data.organizations).toBe(2);
    expect((await api.request('GET', `/orgs/${F.orgA}/team/summary`, { user: F.ownerA })).status).not.toBe(403);
  });

  it('a lapsed subscription (expired) leaves only the core', async () => {
    await api.request('PATCH', `/platform/orgs/${F.orgA}/subscription`, { ...asAdmin, body: { status: 'expired', reason: 'Not renewed' } });
    const a = await modulesOf(F.ownerA, F.orgA);
    expect(a.subscriptionLapsed).toBe(true);
    expect(Object.values(a.modules).some(Boolean)).toBe(false);
    expect((await api.request('GET', `/orgs/${F.orgA}/devices`, { user: F.ownerA })).status).toBe(403);
    expect((await api.request('GET', `/orgs/${F.orgA}/employees`, { user: F.ownerA })).status).toBe(200);
    await api.request('PATCH', `/platform/orgs/${F.orgA}/subscription`, { ...asAdmin, body: { status: 'active', reason: 'Renewed' } });
    expect((await api.request('GET', `/orgs/${F.orgA}/devices`, { user: F.ownerA })).status).toBe(200);
  });

  it('refuses an unknown module and a tenant owner', async () => {
    expect((await api.request('PUT', `/platform/orgs/${F.orgA}/modules`, { ...asAdmin, body: { modules: { nope: false }, reason: 'x y z' } })).status).toBe(400);
    expect((await api.request('PUT', `/platform/orgs/${F.orgA}/modules`, { user: F.ownerA, body: { modules: { leave: false }, reason: 'x y z' } })).status).toBe(403);
    expect((await api.request('PUT', `/platform/orgs/${F.orgA}/modules`, { ...asAdmin, body: { modules: {}, reason: 'x y z' } })).status).toBe(400);
  });
});

describe('plans & pricing', () => {
  it('lists the plans with the reference package: Professional, 500 OMR a year for 11 users', async () => {
    const res = await api.request('GET', '/platform/plans', asAdmin);
    expect(res.status).toBe(200);
    expect(res.json.data.map((p: { key: string }) => p.key)).toEqual(['trial', 'starter', 'professional', 'business', 'enterprise']);
    expect(res.json.data.find((p: { key: string }) => p.key === 'professional')).toMatchObject({
      includedUsers: 11, prices: { OMR: { yearly: 500, monthly: 50, extraUserYearly: 40, extraUserMonthly: 4 } },
      modules: ['devices', 'geofences', 'leave', 'manager_workspace', 'payroll', 'report_schedules', 'self_service'],
    });
  });

  it('creates a plan and a one-field PATCH changes that field only', async () => {
    const created = await api.request('POST', '/platform/plans', { ...asAdmin, body: { key: 'attendance_only', name: 'Attendance only', prices: { OMR: { monthly: 15, yearly: 150 } }, includedUsers: 5, modules: ['devices'], limits: { employees: 20 } } });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ key: 'attendance_only', includedUsers: 5, modules: ['devices'], prices: { OMR: { monthly: 15, yearly: 150, extraUserMonthly: 0, extraUserYearly: 0 } }, isActive: true });
    const patched = await api.request('PATCH', '/platform/plans/attendance_only', { ...asAdmin, body: { name: 'Attendance' } });
    expect(patched.json.data).toMatchObject({ name: 'Attendance', includedUsers: 5, modules: ['devices'], limits: { employees: 20 } });
    expect((await api.request('POST', '/platform/plans', { ...asAdmin, body: { key: 'attendance_only', name: 'Dup' } })).status).toBe(409);
    expect((await api.request('PATCH', '/platform/plans/attendance_only', { ...asAdmin, body: { modules: ['not_a_module'] } })).status).toBe(400);
    expect((await api.request('POST', '/platform/plans', { user: F.ownerA, body: { key: 'mine', name: 'Mine' } })).status).toBe(403);
  });
});

describe('billing', () => {
  let invoiceId = '';
  let invoiceNumber = '';

  it('issues a subscription invoice: Professional yearly, 11 users = 500 OMR + 5% VAT', async () => {
    const res = await api.request('POST', '/platform/billing/invoices', { ...asAdmin, body: { organizationId: F.orgB, planKey: 'professional', billingCycle: 'yearly', seats: 11, periodStart: '2026-10-01' } });
    expect(res.status).toBe(201);
    const inv = res.json.data;
    invoiceId = inv.id; invoiceNumber = inv.invoiceNumber;
    expect(inv.invoiceNumber).toMatch(/^FZT-\d{4}-00001$/);
    expect(inv).toMatchObject({ status: 'issued', currency: 'OMR', planKey: 'professional', billingCycle: 'yearly', seats: 11, periodStart: '2026-10-01', periodEnd: '2027-09-30',
      subtotal: 500, taxRate: 5, taxAmount: 25, total: 525, amountPaid: 0, balance: 525, activatesSubscription: true });
    expect(inv.lines).toHaveLength(1);
    expect(inv.customer).toMatchObject({ legalName: 'Org B LLC' });
    expect(inv.seller).toMatchObject({ name: 'F & Z Capital' });
  });

  it('prices extra users on their own line', async () => {
    const res = await api.request('POST', '/platform/billing/invoices', { ...asAdmin, body: { organizationId: F.orgA, planKey: 'professional', billingCycle: 'yearly', seats: 20, discount: 60, activatesSubscription: false } });
    expect(res.json.data).toMatchObject({ subtotal: 860, discount: 60, taxAmount: 40, total: 840 });
    expect(res.json.data.lines[1]).toMatchObject({ quantity: 9, unitPrice: 40, amount: 360 });
    const voided = await api.request('POST', `/platform/billing/invoices/${res.json.data.id}/void`, { ...asAdmin, body: { reason: 'Issued by mistake' } });
    expect(voided.json.data).toMatchObject({ status: 'void', voidReason: 'Issued by mistake' });
  });

  it('the tenant owner reads their invoices; another tenant cannot', async () => {
    const mine = await api.request('GET', `/orgs/${F.orgB}/billing/invoices`, { user: F.ownerB });
    expect(mine.status).toBe(200);
    expect(mine.json.data.map((i: { invoiceNumber: string }) => i.invoiceNumber)).toEqual([invoiceNumber]);
    expect((await api.request('GET', `/orgs/${F.orgB}/billing/invoices`, { user: F.ownerA })).status).toBe(403);
    expect((await api.request('GET', `/orgs/${F.orgA}/billing/invoices`, { user: F.branchManagerA })).status).toBe(403);
  });

  it('a partial payment keeps the invoice open; an overpayment is refused; the last payment activates the subscription', async () => {
    const part = await api.request('POST', `/platform/billing/invoices/${invoiceId}/payments`, { ...asAdmin, body: { amount: 200, method: 'bank_transfer', reference: 'TRX-1' } });
    expect(part.status).toBe(201);
    expect(part.json.data).toMatchObject({ status: 'issued', amountPaid: 200, balance: 325 });
    expect((await api.request('POST', `/platform/billing/invoices/${invoiceId}/payments`, { ...asAdmin, body: { amount: 400, method: 'cash' } })).status).toBe(400);
    const rest = await api.request('POST', `/platform/billing/invoices/${invoiceId}/payments`, { ...asAdmin, body: { amount: 325, method: 'cheque' } });
    expect(rest.json.data).toMatchObject({ status: 'paid', amountPaid: 525, balance: 0 });
    expect(rest.json.data.subscriptionAppliedAt).not.toBeNull();
    const sub = await api.request('GET', `/platform/orgs/${F.orgB}/subscription`, asAdmin);
    expect(sub.json.data).toMatchObject({ planKey: 'professional', status: 'active', billingCycle: 'yearly', seats: 11, price: { amount: 500 } });
    expect(sub.json.data.currentPeriodEnd.slice(0, 10)).toBe('2027-09-30');
    const org = await api.request('GET', `/platform/orgs/${F.orgB}`, asAdmin);
    expect(org.json.data.status).toBe('active');
    const b = await modulesOf(F.ownerB, F.orgB);
    expect(b.modules).toMatchObject({ leave: true, geofences: true, payroll: true, finance_integration: false });
  });

  it('the tenant sees its plan, price, usage and modules', async () => {
    const res = await api.request('GET', `/orgs/${F.orgB}/subscription`, { user: F.ownerB });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ planKey: 'professional', seats: 11, includedUsers: 11, vatRate: 5, price: { amount: 500, perUserMonthly: 3.788 }, limits: { employees: 11 }, usage: { employees: 1 } });
    expect(res.json.data.availablePlans.map((p: { key: string }) => p.key)).toEqual(['starter', 'professional', 'business', 'enterprise', 'attendance_only']);
    expect(res.json.data.modules.find((m: { key: string }) => m.key === 'finance_integration')).toMatchObject({ enabled: false, inPlan: false });
  });

  it('refunds reopen the invoice; a paid invoice cannot be voided until refunded', async () => {
    expect((await api.request('POST', `/platform/billing/invoices/${invoiceId}/void`, { ...asAdmin, body: { reason: 'Wrong plan' } })).status).toBe(409);
    expect((await api.request('POST', `/platform/billing/invoices/${invoiceId}/payments`, { ...asAdmin, body: { kind: 'refund', amount: 600, method: 'bank_transfer' } })).status).toBe(400);
    const refund = await api.request('POST', `/platform/billing/invoices/${invoiceId}/payments`, { ...asAdmin, body: { kind: 'refund', amount: 25, method: 'bank_transfer' } });
    expect(refund.json.data).toMatchObject({ status: 'issued', amountPaid: 500, balance: 25 });
    expect(refund.json.data.payments.map((p: { kind: string }) => p.kind)).toEqual(['payment', 'payment', 'refund']);
    const payments = await api.request('GET', `/platform/billing/payments?organizationId=${F.orgB}`, asAdmin);
    expect(payments.json.data).toHaveLength(3);
  });

  it('summarises revenue: MRR of paying subscriptions, outstanding invoices', async () => {
    const res = await api.request('GET', '/platform/billing/summary', asAdmin);
    expect(res.status).toBe(200);
    // org B: Professional yearly 500 → 41.667 a month; org A: Business yearly, 25 included users → 1100 → 91.667
    expect(res.json.data).toMatchObject({ currency: 'OMR', payingSubscriptions: 2, outstanding: 25 });
    expect(res.json.data.mrr).toBeCloseTo(133.334, 3);
    expect(res.json.data.arr).toBeCloseTo(1600.008, 3);
  });

  it('the paid seats cap employee creation (402 ENTITLEMENT_EXCEEDED)', async () => {
    await api.request('PATCH', `/platform/orgs/${F.orgA}/subscription`, { ...asAdmin, body: { seats: 2, reason: 'Two licensed users' } });
    const res = await api.request('POST', `/orgs/${F.orgA}/employees`, { user: F.ownerA, body: { employeeNumber: 'E-900', firstName: 'Seat', lastName: 'Three', joiningDate: '2026-02-01', branchId: F.branchHQ } });
    expect(res.status).toBe(402);
    expect(res.json).toMatchObject({ code: 'ENTITLEMENT_EXCEEDED', details: { metric: 'employees', limit: 2 } });
    await api.request('PATCH', `/platform/orgs/${F.orgA}/subscription`, { ...asAdmin, body: { seats: null, reason: 'Back to the plan limit' } });
  });
});

describe('user limit (migration 20261001000300)', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const newEmployee = (n: string) => ({ employeeNumber: n, firstName: 'Limit', lastName: n, joiningDate: '2026-02-01', branchId: F.branchHQ });
  let used = 0;
  let firstId = '';

  it('the platform sets the user limit; the tenant page, the tenants list and the tenant itself see "used / limit"', async () => {
    used = (await api.request('GET', `/platform/orgs/${F.orgA}/subscription`, asAdmin)).json.data.userLimit.used;
    expect(used).toBeGreaterThan(0);
    const patch = await api.request('PATCH', `/platform/orgs/${F.orgA}/subscription`, { ...asAdmin, body: { seats: used + 1, reason: 'One more licensed user' } });
    expect(patch.status).toBe(200);
    const expected = { used, limit: used + 1, remaining: 1, reached: false, source: 'seats' };
    expect(patch.json.data.userLimit).toEqual(expected);
    expect((await api.request('GET', `/platform/orgs/${F.orgA}`, asAdmin)).json.data.userLimit).toEqual(expected);
    const list = await api.request('GET', '/platform/orgs?search=TEST-A', asAdmin);
    expect(list.json.data.find((o: { id: string }) => o.id === F.orgA).userLimit).toEqual(expected);
    // org B keeps its own: the 11 users of the Professional invoice it paid above
    expect(list.json.data.find((o: { id: string }) => o.id === F.orgB)).toBeUndefined();
    expect((await api.request('GET', `/platform/orgs/${F.orgB}`, asAdmin)).json.data.userLimit).toEqual({ used: 1, limit: 11, remaining: 10, reached: false, source: 'seats' });
    // the tenant reads it, never changes it
    const mine = await api.request('GET', `/orgs/${F.orgA}/user-limit`, { user: F.ownerA });
    expect(mine.status).toBe(200);
    expect(mine.json.data).toEqual(expected);
    const sub = await api.request('GET', `/orgs/${F.orgA}/subscription`, { user: F.ownerA });
    expect(sub.json.data).toMatchObject({ seats: used + 1, userLimit: expected, limits: { employees: used + 1 }, usage: { employees: used } });
    expect((await api.request('GET', `/orgs/${F.orgA}/user-limit`, { user: F.ownerB })).status).toBe(403);
    expect((await api.request('PATCH', `/platform/orgs/${F.orgA}/subscription`, { user: F.ownerA, body: { seats: 500, reason: 'More users please' } })).status).toBe(403);
  });

  it('adding employees stops at the limit with "Maximum users reached"', async () => {
    const first = await api.request('POST', `/orgs/${F.orgA}/employees`, { user: F.ownerA, body: newEmployee('UL-1') });
    expect(first.status).toBe(201);
    firstId = first.json.data.id;
    expect((await api.request('GET', `/orgs/${F.orgA}/user-limit`, { user: F.ownerA })).json.data).toMatchObject({ used: used + 1, remaining: 0, reached: true });
    expect((await api.request('GET', `/platform/orgs/${F.orgA}/subscription`, asAdmin)).json.data.userLimit).toMatchObject({ used: used + 1, limit: used + 1, reached: true });
    const refused = await api.request('POST', `/orgs/${F.orgA}/employees`, { user: F.ownerA, body: newEmployee('UL-2') });
    expect(refused.status).toBe(402);
    expect(refused.json).toMatchObject({ code: 'ENTITLEMENT_EXCEEDED', details: { metric: 'employees', reason: 'USER_LIMIT_REACHED', limit: used + 1, used: used + 1 } });
    expect(refused.json.message).toContain('Maximum users reached');
    expect((await api.tdb.adminDb.selectFrom('employees').select('id').where('employeeNumber', '=', 'UL-2').execute())).toHaveLength(0);
  });

  it('a leaver frees a user; re-activating one (alone or in bulk) is refused while the limit is reached', async () => {
    const left = await api.request('PATCH', `/orgs/${F.orgA}/employees/${firstId}`, { user: F.ownerA, body: { employmentStatus: 'resigned', exitDate: '2026-09-30' } });
    expect(left.status).toBe(200);
    expect((await api.request('GET', `/orgs/${F.orgA}/user-limit`, { user: F.ownerA })).json.data).toMatchObject({ used, remaining: 1, reached: false });
    expect((await api.request('POST', `/orgs/${F.orgA}/employees`, { user: F.ownerA, body: newEmployee('UL-3') })).status).toBe(201);
    const back = await api.request('PATCH', `/orgs/${F.orgA}/employees/${firstId}`, { user: F.ownerA, body: { employmentStatus: 'active' } });
    expect(back.status).toBe(402);
    expect(back.json.details).toMatchObject({ reason: 'USER_LIMIT_REACHED' });
    const bulk = await api.request('POST', `/orgs/${F.orgA}/employees/bulk`, { user: F.ownerA, body: { action: 'set_status', employeeIds: [firstId], employmentStatus: 'active' } });
    expect(bulk.status).toBe(402);
    expect((await api.tdb.adminDb.selectFrom('employees').select('employmentStatus').where('id', '=', firstId).executeTakeFirstOrThrow()).employmentStatus).toBe('resigned');
  });

  it('an import that would take the tenant past the limit cannot be confirmed', async () => {
    await api.request('PATCH', `/platform/orgs/${F.orgA}/subscription`, { ...asAdmin, body: { seats: used + 2, reason: 'One more user' } });
    const csv = ['employeeNumber,firstName,lastName,joiningDate,branchCode', 'UL-10,One,Import,2026-03-01,A-HQ', 'UL-11,Two,Import,2026-03-01,A-HQ'].join('\r\n');
    const up = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'limit.csv', contentBase64: b64(csv) } });
    expect(up.json.data).toMatchObject({ status: 'VALIDATED', validRows: 2 });
    const confirm = await api.request('POST', `/orgs/${F.orgA}/employees/imports/${up.json.data.id}/confirm`, { user: F.ownerA, headers: { 'idempotency-key': 'user-limit-import' } });
    expect(confirm.status).toBe(402);
    expect(confirm.json).toMatchObject({ code: 'ENTITLEMENT_EXCEEDED', details: { reason: 'USER_LIMIT_REACHED', limit: used + 2, used: used + 1, adding: 2 } });
    expect(confirm.json.message).toContain('Only 1 of');
    expect((await api.request('GET', `/orgs/${F.orgA}/employees/imports/${up.json.data.id}`, { user: F.ownerA })).json.data.status).toBe('VALIDATED');
  });

  it('only the platform raises the limit; then the leaver can come back, and the change is on the tenant\'s audit log', async () => {
    const raised = await api.request('PATCH', `/platform/orgs/${F.orgA}/subscription`, { ...asAdmin, body: { seats: used + 5, reason: 'Customer bought more users' } });
    expect(raised.json.data.userLimit).toMatchObject({ used: used + 1, limit: used + 5, remaining: 4, reached: false });
    expect((await api.request('PATCH', `/orgs/${F.orgA}/employees/${firstId}`, { user: F.ownerA, body: { employmentStatus: 'active', exitDate: null } })).status).toBe(200);
    const log = await api.request('GET', `/orgs/${F.orgA}/audit?action=organization.subscription_changed`, { user: F.ownerA });
    expect(log.json.data[0]).toMatchObject({ actorType: 'PLATFORM_ADMIN', reason: 'Customer bought more users' });
    // back to the plan's employee limit for the suites that follow
    const reset = await api.request('PATCH', `/platform/orgs/${F.orgA}/subscription`, { ...asAdmin, body: { seats: null, reason: 'Back to the plan limit' } });
    expect(reset.json.data.userLimit).toMatchObject({ source: 'plan' });
  });
});

describe('platform settings', () => {
  it('reads and updates settings; the invoice prefix applies to the next invoice', async () => {
    const get = await api.request('GET', '/platform/settings', asAdmin);
    expect(get.json.data).toMatchObject({ general: { platformName: 'FlowZa Time' }, billing: { currency: 'OMR', vatRate: 5, invoicePrefix: 'FZT', paymentTermsDays: 14 } });
    const put = await api.request('PUT', '/platform/settings', { ...asAdmin, body: { billing: { invoicePrefix: 'fzti', bankDetails: 'Bank Muscat · OM12 0270 0000 0000 1234 5678' } } });
    expect(put.status).toBe(200);
    expect(put.json.data.billing).toMatchObject({ invoicePrefix: 'FZTI', vatRate: 5 });
    const inv = await api.request('POST', '/platform/billing/invoices', { ...asAdmin, body: { organizationId: F.orgA, lines: [{ description: 'Device installation', quantity: 2, unitPrice: 35 }] } });
    expect(inv.json.data).toMatchObject({ invoiceNumber: expect.stringMatching(/^FZTI-\d{4}-00001$/), billingCycle: 'custom', subtotal: 70, taxAmount: 3.5, total: 73.5, activatesSubscription: false });
    expect(inv.json.data.seller.bankDetails).toContain('Bank Muscat');
    expect((await api.request('PUT', '/platform/settings', { user: F.ownerA, body: { billing: { vatRate: 0 } } })).status).toBe(403);
    expect((await api.request('PUT', '/platform/settings', { ...asAdmin, body: {} })).status).toBe(400);
  });
});
