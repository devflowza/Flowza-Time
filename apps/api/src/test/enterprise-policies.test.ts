import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { withContext } from '@flowza/database';
import { employeePolicyOn } from '../services/policies/enforcement.js';
import { auditRows, createApiHarness, queueJobs, ROLE, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

/*
 * Global attendance policies (Enterprise, module attendance_policies — docs/enterprise/plan.md §4–§7): the module gate, scoped
 * policies (rule sets), employee groups and memberships, "which policy applies", country packs and compliance, attendance
 * points and the overtime summary, with RLS and branch scope.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let off: OrgFixture;
/** A branch-scoped (branch B) HR admin — attendance.manage_rules on branch B only — and a branch-scoped HR user. */
let scopedAdmin: string; let scopedHr: string;
beforeAll(async () => {
  h = await createApiHarness(`flowza_api_policies_${process.pid}`);
  f = await seedOrg(h.admin, 'pol', { modules: ['attendance_policies'] });
  off = await seedOrg(h.admin, 'poloff');
  scopedAdmin = uuid('c'); scopedHr = uuid('c');
  await seedUser(h.admin, scopedAdmin, 'scoped-admin-pol@test.local', 'Scoped admin');
  await seedUser(h.admin, scopedHr, 'scoped-hr-pol@test.local', 'Scoped HR');
  await seedMembership(h.admin, f.orgId, scopedAdmin, ROLE.hr_admin, { branchIds: [f.branchB] });
  await seedMembership(h.admin, f.orgId, scopedHr, ROLE.hr_user, { branchIds: [f.branchB] });
});
afterAll(async () => { await h?.close(); });
const base = (o: OrgFixture = f) => `/api/v1/orgs/${o.orgId}`;
const latestRecalc = () => h.admin.selectFrom('attendanceRecalculationRequests').selectAll().where('organizationId', '=', f.orgId).orderBy('createdAt', 'desc').executeTakeFirstOrThrow();
const recalcCount = async () => (await queueJobs(h.admin, 'RECALCULATE_RANGE')).length;
const seedRecord = (employeeId: string, branchId: string, date: string, status: string, flags: string[] = [], extra: Record<string, unknown> = {}) =>
  h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId, attendanceDate: date, branchId, timezone: 'Asia/Muscat', engineVersion: 'test', status: status as never, flags, workedMinutes: 0, trace: JSON.stringify({}), ...extra } as never).execute();

describe('module gate: attendance_policies off (trial plan)', () => {
  it('refuses the employee groups and the policy endpoints with FEATURE_DISABLED', async () => {
    for (const path of ['/employee-groups', '/attendance-policies/country-packs', `/attendance-policies/points`]) {
      const r = await h.request('GET', `${base(off)}${path}`, { token: off.hrAdmin });
      expect(r.status, path).toBe(403);
      expect(r.body.code).toBe('FEATURE_DISABLED');
      expect(r.body.details).toMatchObject({ module: 'attendance_policies' });
    }
  });

  it('a rule set beyond the branch, or with non-default sections, needs the module; the classic rule sets do not', async () => {
    const scoped = await h.request('POST', `${base(off)}/attendance-rule-sets`, { token: off.hrAdmin, body: { name: 'Ops', departmentId: off.departmentA, effectiveFrom: '2026-01-01' } });
    expect(scoped.status).toBe(403);
    expect(scoped.body.code).toBe('FEATURE_DISABLED');
    const country = await h.request('POST', `${base(off)}/attendance-rule-sets`, { token: off.hrAdmin, body: { name: 'Oman', countryCode: 'OM', effectiveFrom: '2026-01-01' } });
    expect(country.status).toBe(403);
    const sections = await h.request('POST', `${base(off)}/attendance-rule-sets`, { token: off.hrAdmin, body: { name: 'Points', effectiveFrom: '2026-01-01', policy: { points: { enabled: true } } } });
    expect(sections.status).toBe(403);
    const classic = await h.request('POST', `${base(off)}/attendance-rule-sets`, { token: off.hrAdmin, body: { name: 'Branch A', branchId: off.branchA, effectiveFrom: '2026-01-01', policy: {} } });
    expect(classic.status).toBe(201);
    expect(classic.body.data).toMatchObject({ description: '', countryCode: null, departmentId: null, employeeGroupId: null, shiftId: null, policy: { points: { enabled: false } } });
    const id = classic.body.data.id as string;
    expect((await h.request('PATCH', `${base(off)}/attendance-rule-sets/${id}`, { token: off.hrAdmin, body: { graceInMinutes: 7 } })).status).toBe(200);
    expect((await h.request('PATCH', `${base(off)}/attendance-rule-sets/${id}`, { token: off.hrAdmin, body: { policy: { points: { enabled: true } } } })).body.code).toBe('FEATURE_DISABLED');
    expect((await h.request('PATCH', `${base(off)}/attendance-rule-sets/${id}`, { token: off.hrAdmin, body: { policy: {} } })).status).toBe(200);
  });
});

describe('employee groups and memberships', () => {
  let office: string; let sales: string;
  it('CRUD: read with attendance.view, write with attendance.manage_rules on every branch', async () => {
    expect((await h.request('POST', `${base()}/employee-groups`, { token: f.hrUser, body: { code: 'OFFICE', name: 'Office staff' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/employee-groups`, { token: scopedAdmin, body: { code: 'OFFICE', name: 'Office staff' } })).status).toBe(403);
    const a = await h.request('POST', `${base()}/employee-groups`, { token: f.hrAdmin, body: { code: 'OFFICE', name: 'Office staff', nameAr: 'موظفو المكتب' } });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ code: 'OFFICE', name: 'Office staff', nameAr: 'موظفو المكتب', description: '', status: 'active', memberCount: 0, policyCount: 0 });
    office = a.body.data.id;
    const b = await h.request('POST', `${base()}/employee-groups`, { token: f.hrAdmin, body: { code: 'SALES', name: 'Sales staff', description: 'Field sales' } });
    sales = b.body.data.id;
    expect((await h.request('POST', `${base()}/employee-groups`, { token: f.hrAdmin, body: { code: 'office', name: 'Duplicate' } })).status).toBe(409); // citext code
    const renamed = await h.request('PATCH', `${base()}/employee-groups/${sales}`, { token: f.hrAdmin, body: { name: 'Sales team' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ code: 'SALES', name: 'Sales team', description: 'Field sales', status: 'active' }); // PATCH keeps the rest
    const list = await h.request('GET', `${base()}/employee-groups`, { token: f.hrUser });
    expect(list.status).toBe(200);
    expect(list.body.data.map((g: { code: string }) => g.code)).toEqual(['OFFICE', 'SALES']);
    expect((await auditRows(h.admin, 'attendance.employee_group_created')).length).toBe(2);
  });

  it('puts employees in a group from a date and recomputes them from that date', async () => {
    const before = await recalcCount();
    const r = await h.request('POST', `${base()}/employee-groups/${office}/members`, { token: f.hrAdmin, body: { employeeIds: [f.e1, f.e3], effectiveFrom: '2026-01-01' } });
    expect(r.status).toBe(201);
    expect(r.body.data.added.map((m: { employeeId: string }) => m.employeeId).sort()).toEqual([f.e1, f.e3].sort());
    expect(r.body.data.added[0]).toMatchObject({ employeeGroupId: office, effectiveFrom: '2026-01-01', effectiveTo: null, branchId: f.branchA });
    expect(r.body.data.ended).toEqual([]);
    expect(r.body.data.recalculationJobId).toBeTypeOf('string');
    expect(await recalcCount()).toBe(before + 1);
    const req = await latestRecalc();
    expect([...(req.employeeIds ?? [])].sort()).toEqual([f.e1, f.e3].sort());
    expect(req.branchId).toBeNull();
    const g = await h.request('GET', `${base()}/employee-groups/${office}`, { token: f.hrUser });
    expect(g.body.data.memberCount).toBe(2);
  });

  it('an open-ended membership of any group ends the day before a later one starts; any other overlap is a 409 naming the employee', async () => {
    const move = await h.request('POST', `${base()}/employee-groups/${sales}/members`, { token: f.hrAdmin, body: { employeeIds: [f.e1], effectiveFrom: '2026-03-01' } });
    expect(move.status).toBe(201);
    expect(move.body.data.ended).toEqual([expect.objectContaining({ employeeId: f.e1, employeeGroupId: office, effectiveFrom: '2026-01-01', effectiveTo: '2026-02-28' })]);
    const stored = await h.admin.selectFrom('employeeGroupMemberships').select(sql<string>`effective_to::text`.as('to')).where('employeeId', '=', f.e1).where('employeeGroupId', '=', office).executeTakeFirstOrThrow();
    expect(stored.to).toBe('2026-03-01'); // exclusive bound
    const clash = await h.request('POST', `${base()}/employee-groups/${office}/members`, { token: f.hrAdmin, body: { employeeIds: [f.e1], effectiveFrom: '2026-02-01' } });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toContain('Employee 1');
    expect(clash.body.details).toMatchObject({ employeeId: f.e1 });
    // nothing was written by the refused request
    expect((await h.admin.selectFrom('employeeGroupMemberships').select('id').where('employeeId', '=', f.e1).execute()).length).toBe(2);
    const all = await h.request('GET', `${base()}/employee-groups/${office}/members?all=true`, { token: f.hrUser });
    expect(all.body.meta.total).toBe(2);
    const onMarch = await h.request('GET', `${base()}/employee-groups/${office}/members?activeOn=2026-03-15`, { token: f.hrUser });
    expect(onMarch.body.data.map((m: { employeeId: string }) => m.employeeId)).toEqual([f.e3]);
  });

  it('a branch-scoped manager manages the memberships of their own branch only', async () => {
    const other = await h.request('POST', `${base()}/employee-groups/${sales}/members`, { token: scopedAdmin, body: { employeeIds: [f.e1, f.e2], effectiveFrom: '2026-05-01' } });
    expect(other.status).toBe(404); // branch A's employee is not visible to them
    expect(other.body.details).toMatchObject({ employeeIds: [f.e1] });
    const own = await h.request('POST', `${base()}/employee-groups/${sales}/members`, { token: scopedAdmin, body: { employeeIds: [f.e2], effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' } });
    expect(own.status).toBe(201);
    expect(own.body.data.added[0]).toMatchObject({ employeeId: f.e2, effectiveTo: '2026-06-30' });
    // they see the members of their branch only
    const visible = await h.request('GET', `${base()}/employee-groups/${sales}/members?all=true`, { token: scopedAdmin });
    expect(visible.body.data.map((m: { employeeId: string }) => m.employeeId)).toEqual([f.e2]);
    const e1Membership = (await h.request('GET', `${base()}/employee-groups/${sales}/members?all=true`, { token: f.hrAdmin })).body.data.find((m: { employeeId: string }) => m.employeeId === f.e1);
    expect((await h.request('DELETE', `${base()}/employee-groups/${sales}/members/${e1Membership.id}`, { token: scopedAdmin })).status).toBe(404);
    // ends on an inclusive last day; before the first day is refused (DELETE removes it)
    const end = await h.request('PATCH', `${base()}/employee-groups/${sales}/members/${own.body.data.added[0].id}`, { token: scopedAdmin, body: { effectiveTo: '2026-04-30' } });
    expect(end.status).toBe(200);
    expect(end.body.data.effectiveTo).toBe('2026-04-30');
    const stored = await h.admin.selectFrom('employeeGroupMemberships').select(sql<string>`effective_to::text`.as('to')).where('id', '=', own.body.data.added[0].id).executeTakeFirstOrThrow();
    expect(stored.to).toBe('2026-05-01');
    const req = await latestRecalc();
    expect(req.employeeIds).toEqual([f.e2]);
    expect((await h.request('PATCH', `${base()}/employee-groups/${sales}/members/${own.body.data.added[0].id}`, { token: scopedAdmin, body: { effectiveTo: '2025-12-31' } })).status).toBe(400);
    const del = await h.request('DELETE', `${base()}/employee-groups/${sales}/members/${own.body.data.added[0].id}`, { token: scopedAdmin });
    expect(del.status).toBe(200);
    expect(del.body.data.recalculationJobId).toBeTypeOf('string');
    expect((await auditRows(h.admin, 'attendance.employee_group_membership_deleted')).length).toBe(1);
  });

  it('a group a policy uses cannot be deleted (409); an unused one goes with its memberships', async () => {
    const temp = await h.request('POST', `${base()}/employee-groups`, { token: f.hrAdmin, body: { code: 'TEMP', name: 'Temporary' } });
    await h.request('POST', `${base()}/employee-groups/${temp.body.data.id}/members`, { token: f.hrAdmin, body: { employeeIds: [f.e2], effectiveFrom: '2027-01-01' } });
    const p = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Temp policy', employeeGroupId: temp.body.data.id, effectiveFrom: '2027-01-01' } });
    expect(p.status).toBe(201);
    const refused = await h.request('DELETE', `${base()}/employee-groups/${temp.body.data.id}`, { token: f.hrAdmin });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CONFLICT');
    expect((await h.request('DELETE', `${base()}/attendance-rule-sets/${p.body.data.id}`, { token: f.hrAdmin })).status).toBe(200);
    expect((await h.request('DELETE', `${base()}/employee-groups/${temp.body.data.id}`, { token: f.hrAdmin })).status).toBe(204);
    expect((await h.admin.selectFrom('employeeGroupMemberships').select('id').where('employeeGroupId', '=', temp.body.data.id).execute()).length).toBe(0);
  });
});

describe('scoped policies, resolution and compliance', () => {
  let office: string; let longShift: string; let groupPolicy: string; let deptPolicy: string;
  beforeAll(async () => {
    office = (await h.admin.selectFrom('employeeGroups').select('id').where('organizationId', '=', f.orgId).where('code', '=', 'OFFICE').executeTakeFirstOrThrow()).id;
    longShift = (await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'LONG', name: 'Long day', type: 'FIXED', startTime: '08:00', endTime: '18:00' } })).body.data.id;
    await h.admin.updateTable('branches').set({ countryCode: 'OM' }).where('organizationId', '=', f.orgId).execute();
  });

  it('creates policies by scope; unknown dimensions are refused; the list filters by dimension', async () => {
    const org = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Organisation default', effectiveFrom: '2026-01-01' } });
    expect(org.status).toBe(201);
    const gp = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: {
      name: 'Oman – Office Employees', description: 'Office staff in Oman', countryCode: 'OM', employeeGroupId: office, effectiveFrom: '2026-01-01', graceInMinutes: 15,
      policy: {
        late: { veryLateAfterMinutes: 60, repeatedLate: { occurrences: 3, periodDays: 30 } },
        overtime: { weeklyThresholdMinutes: 2400, maxDailyWorkMinutes: 600, rates: { regular: 1.25, weekly: 1.5, weeklyOff: 2, holiday: 2.5 } },
        points: { enabled: true, expiryDays: 30, escalation: [{ points: 2, action: 'NOTIFY_MANAGER' }, { points: 5, action: 'VERBAL_WARNING' }] },
      },
    } });
    expect(gp.status).toBe(201);
    groupPolicy = gp.body.data.id;
    expect(gp.body.data).toMatchObject({ countryCode: 'OM', employeeGroupId: office, description: 'Office staff in Oman', policy: { points: { enabled: true, late: 1, absent: 3 }, methods: { web: true, requireGeofence: 'inherit' } } });
    const dp = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Operations', departmentId: f.departmentA, effectiveFrom: '2026-01-01' } });
    expect(dp.status).toBe(201);
    deptPolicy = dp.body.data.id;
    const branchB = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Branch B', branchId: f.branchB, effectiveFrom: '2026-01-01' } });
    expect(branchB.status).toBe(201);
    expect((await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Branch A', branchId: f.branchA, effectiveFrom: '2026-01-01' } })).status).toBe(201);
    const shiftPolicy = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Long days', shiftId: longShift, effectiveFrom: '2026-01-01' } });
    expect(shiftPolicy.status).toBe(201);
    // the same scope cannot overlap; another scope can
    expect((await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Clash', employeeGroupId: office, countryCode: 'OM', effectiveFrom: '2026-06-01' } })).status).toBe(409);
    for (const [key, value] of [['departmentId', uuid('d')], ['employeeGroupId', uuid('g')], ['shiftId', uuid('s')]] as const) {
      const bad = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Unknown', [key]: value, effectiveFrom: '2030-01-01' } });
      expect(bad.status, key).toBe(400);
      expect(bad.body.details.issues[0].path).toBe(key);
    }
    const byGroup = await h.request('GET', `${base()}/attendance-rule-sets?employeeGroupId=${office}`, { token: f.hrUser });
    expect(byGroup.body.data.map((p: { id: string }) => p.id)).toEqual([groupPolicy]);
    expect((await h.request('GET', `${base()}/attendance-rule-sets?countryCode=OM`, { token: f.hrUser })).body.data).toHaveLength(1);
    expect((await h.request('GET', `${base()}/attendance-rule-sets?departmentId=${f.departmentA}`, { token: f.hrUser })).body.data.map((p: { id: string }) => p.id)).toEqual([deptPolicy]);
    expect((await h.request('GET', `${base()}/attendance-rule-sets?shiftId=${longShift}`, { token: f.hrUser })).body.data).toHaveLength(1);
    expect((await h.request('GET', `${base()}/attendance-rule-sets`, { token: f.hrUser })).body.data).toHaveLength(6);
    // the group is now used by a policy
    expect((await h.request('GET', `${base()}/employee-groups/${office}`, { token: f.hrUser })).body.data.policyCount).toBe(1);
  });

  it('PATCH of one field changes that field only; the scope is immutable; the sections are replaced as a whole', async () => {
    const before = await h.admin.selectFrom('attendanceRuleSets').selectAll().where('id', '=', groupPolicy).executeTakeFirstOrThrow();
    const p = await h.request('PATCH', `${base()}/attendance-rule-sets/${groupPolicy}`, { token: f.hrAdmin, body: { graceInMinutes: 20 } });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ graceInMinutes: 20, description: 'Office staff in Oman', countryCode: 'OM', employeeGroupId: office, version: before.version + 1 });
    const after = await h.admin.selectFrom('attendanceRuleSets').selectAll().where('id', '=', groupPolicy).executeTakeFirstOrThrow();
    expect(after.policy).toEqual(before.policy);
    expect({ ...after, graceInMinutes: 15, version: before.version, updatedAt: before.updatedAt }).toEqual(before);
    for (const [key, value] of [['employeeGroupId', null], ['countryCode', 'AE'], ['departmentId', f.departmentA], ['shiftId', longShift], ['branchId', f.branchA]] as const) {
      const r = await h.request('PATCH', `${base()}/attendance-rule-sets/${groupPolicy}`, { token: f.hrAdmin, body: { [key]: value } });
      expect(r.status, key).toBe(400);
      expect(r.body.details.issues[0]).toMatchObject({ path: key, message: 'Immutable' });
    }
    // sending the same scope back is fine (the editor sends the whole form)
    expect((await h.request('PATCH', `${base()}/attendance-rule-sets/${groupPolicy}`, { token: f.hrAdmin, body: { countryCode: 'OM', employeeGroupId: office, branchId: null, name: 'Oman – Office Employees' } })).status).toBe(200);
    // a policy object replaces the stored one (defaults for what it leaves out)
    const replaced = await h.request('PATCH', `${base()}/attendance-rule-sets/${groupPolicy}`, { token: f.hrAdmin, body: { policy: { ...p.body.data.policy, regularisation: { maxPerMonth: 3, backdateDays: 7 } } } });
    expect(replaced.body.data.policy).toMatchObject({ regularisation: { maxPerMonth: 3, backdateDays: 7 }, points: { enabled: true } });
  });

  it('resolves the most specific policy for an employee and day, and explains the others', async () => {
    // e3: branch A, department A, group OFFICE → the group policy (16 + 2) beats the department (8) and the organisation (0)
    const r = await h.request('GET', `${base()}/attendance-policies/resolve?employeeId=${f.e3}&date=2026-02-10`, { token: f.hrUser });
    expect(r.status).toBe(200);
    expect(r.body.data.scope).toEqual({ countryCode: 'OM', branchId: f.branchA, departmentId: f.departmentA, employeeGroupId: office, shiftId: null });
    expect(r.body.data.policy).toMatchObject({ id: groupPolicy, name: 'Oman – Office Employees', specificity: 18 });
    const byName = Object.fromEntries(r.body.data.candidates.map((c: { name: string }) => [c.name, c]));
    expect(byName['Operations']).toMatchObject({ matches: true, mismatch: null, specificity: 8 });
    expect(byName['Organisation default']).toMatchObject({ matches: true, specificity: 0 });
    expect(byName['Branch B']).toMatchObject({ matches: false, mismatch: 'BRANCH' });
    expect(byName['Branch A']).toMatchObject({ matches: true, specificity: 4 });
    expect(byName['Long days']).toMatchObject({ matches: false, mismatch: 'SHIFT' });
    expect(r.body.data.candidates[0].id).toBe(groupPolicy);
    // e1 left the group on 1 March → the department policy
    const e1 = await h.request('GET', `${base()}/attendance-policies/resolve?employeeId=${f.e1}&date=2026-03-10`, { token: f.hrUser });
    expect(e1.body.data.policy.id).toBe(deptPolicy);
    expect(e1.body.data.candidates.find((c: { id: string }) => c.id === groupPolicy)).toMatchObject({ matches: false, mismatch: 'EMPLOYEE_GROUP' });
    // the same answer as the engine's input (GET /shifts/resolve reads the same resolver)
    expect((await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e3}&date=2026-02-10`, { token: f.hrUser })).body.data.ruleSet.id).toBe(groupPolicy);
    // a shift assignment puts the employee on the shift policy (32 beats the group's 18)
    await h.request('POST', `${base()}/shift-assignments`, { token: f.hrAdmin, body: { targetType: 'EMPLOYEE', targetId: f.e3, shiftId: longShift, effectiveFrom: '2026-08-01', effectiveTo: '2026-08-31' } });
    expect((await h.request('GET', `${base()}/attendance-policies/resolve?employeeId=${f.e3}&date=2026-08-10`, { token: f.hrUser })).body.data.policy.name).toBe('Long days');
    // a branch-scoped user: their own branch's employee only; another branch's policies are not listed
    expect((await h.request('GET', `${base()}/attendance-policies/resolve?employeeId=${f.e3}&date=2026-02-10`, { token: scopedHr })).status).toBe(404);
    const scoped = await h.request('GET', `${base()}/attendance-policies/resolve?employeeId=${f.e2}&date=2026-02-10`, { token: scopedHr });
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.policy.name).toBe('Branch B');
    const names = scoped.body.data.candidates.map((c: { name: string }) => c.name);
    expect(names).not.toContain('Branch A'); // another branch's policy is not theirs to read
    expect(names).toEqual(expect.arrayContaining(['Branch B', 'Organisation default', 'Operations']));
  });

  it('the self-service endpoints can read the policy of the employee from the employee\'s own context', async () => {
    // the employee cannot read the rule sets themselves (no attendance.view): the helper resolves in the system scope
    const own = await withContext(h.deps.db, { kind: 'user', userId: f.employeeUser, requestId: 'policy-self' }, (trx) => employeePolicyOn(trx, f.orgId, f.e1, '2026-03-10'));
    expect(own?.row?.id).toBe(deptPolicy);
    const visible = await withContext(h.deps.db, { kind: 'user', userId: f.employeeUser, requestId: 'policy-self' }, (trx) => trx.selectFrom('attendanceRuleSets').select('id').execute());
    expect(visible).toEqual([]);
  });

  it('country packs and the compliance check of a draft', async () => {
    const packs = await h.request('GET', `${base()}/attendance-policies/country-packs`, { token: f.hrUser });
    expect(packs.body.data.map((p: { code: string }) => p.code)).toEqual(['OM', 'AE', 'SA', 'QA', 'KW', 'BH', 'IN']);
    const draft = { name: 'Draft', effectiveFrom: '2026-01-01', shiftId: longShift, overtimeMaxMinutesPerDay: 300, policy: { overtime: { weeklyThresholdMinutes: 2400, maxDailyWorkMinutes: 720, rates: { regular: 1, weekly: 1.25, weeklyOff: 2, holiday: 2 } } }, ramadanMode: { enabled: false, scheduledMinutes: 360, appliesTo: 'flagged_employees' } };
    const r = await h.request('POST', `${base()}/attendance-policies/compliance?countryCode=OM`, { token: f.hrUser, body: draft });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ countryCode: 'OM', packVersion: '2026.10' });
    expect(r.body.data.warnings.map((w: { code: string; field: string }) => `${w.code}:${w.field}`)).toEqual(['OVERTIME_CAP_ABOVE_LAW:overtimeMaxMinutesPerDay', 'OVERTIME_RATE_BELOW_LAW:policy.overtime.rates.regular', 'SHIFT_LONGER_THAN_STATUTORY_DAY:shiftId']);
    expect(r.body.data.warnings[2].params).toEqual({ value: 600, law: 480 });
    const none = await h.request('POST', `${base()}/attendance-policies/compliance?countryCode=FR`, { token: f.hrUser, body: draft });
    expect(none.body.data).toEqual({ countryCode: 'FR', packVersion: null, warnings: [] });
    expect((await h.request('POST', `${base()}/attendance-policies/compliance?countryCode=OM`, { token: f.hrUser, body: { name: 'x' } })).status).toBe(400);
  });
});

describe('attendance points and the overtime summary', () => {
  beforeAll(async () => {
    // e3 is on the office policy (points on, 30-day window): March
    await seedRecord(f.e3, f.branchA, '2026-02-20', 'PRESENT', ['LATE']); // outside the window of 31 March
    await seedRecord(f.e3, f.branchA, '2026-03-10', 'PRESENT', ['LATE']);
    await seedRecord(f.e3, f.branchA, '2026-03-11', 'ABSENT', []);
    await seedRecord(f.e3, f.branchA, '2026-03-12', 'PRESENT', ['LATE', 'EXCUSED']);
    // e1 is on the department policy (points off) — late days count nothing
    await seedRecord(f.e1, f.branchA, '2026-03-10', 'PRESENT', ['LATE']);
    await seedRecord(f.e2, f.branchB, '2026-03-10', 'ABSENT', []);
    // May (Friday 1st; the week of Monday 4 → Sunday 10 is in May): 660 (180 OT, over the 600 daily maximum) + 4 × 540 + a
    // weekly off worked (300, all WEEKLY_OFF overtime) → 3120 − 2400 − 480 = 240 weekly overtime
    await seedRecord(f.e3, f.branchA, '2026-05-04', 'PRESENT', ['OVERTIME'], { workedMinutes: 660, overtimeMinutes: 180, overtimeCategory: 'REGULAR' });
    for (const d of ['2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08']) await seedRecord(f.e3, f.branchA, d, 'PRESENT', [], { workedMinutes: 540 });
    await seedRecord(f.e3, f.branchA, '2026-05-09', 'WEEKLY_OFF', ['WORKED_ON_WEEKLY_OFF'], { workedMinutes: 300, overtimeMinutes: 300, overtimeCategory: 'WEEKLY_OFF' });
    await seedRecord(f.e1, f.branchA, '2026-05-04', 'PRESENT', ['OVERTIME'], { workedMinutes: 600, overtimeMinutes: 120, overtimeCategory: 'REGULAR' });
  });

  it('scores each employee under the policy resolved for them on the as-of date', async () => {
    const r = await h.request('GET', `${base()}/attendance-policies/points?asOf=2026-03-31`, { token: f.hrUser });
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ asOf: '2026-03-31', total: 3 });
    const byEmployee = Object.fromEntries(r.body.data.map((row: { employeeId: string }) => [row.employeeId, row]));
    expect(byEmployee[f.e3]).toMatchObject({ pointsEnabled: true, points: 4, policyName: 'Oman – Office Employees', occurrences: { LATE: 1, ABSENT: 1 }, escalation: { action: 'NOTIFY_MANAGER', threshold: 2 }, nextEscalation: { action: 'VERBAL_WARNING', threshold: 5 } });
    expect(byEmployee[f.e1]).toMatchObject({ pointsEnabled: false, points: 0, policyName: 'Operations', escalation: null });
    expect(byEmployee[f.e2]).toMatchObject({ pointsEnabled: false, points: 0, policyName: 'Branch B' });
    const min = await h.request('GET', `${base()}/attendance-policies/points?asOf=2026-03-31&minPoints=1`, { token: f.hrUser });
    expect(min.body.data.map((row: { employeeId: string }) => row.employeeId)).toEqual([f.e3]);
    const group = await h.request('GET', `${base()}/attendance-policies/points?asOf=2026-03-31&employeeGroupId=${(await h.admin.selectFrom('employeeGroups').select('id').where('code', '=', 'OFFICE').where('organizationId', '=', f.orgId).executeTakeFirstOrThrow()).id}`, { token: f.hrUser });
    expect(group.body.data.map((row: { employeeId: string }) => row.employeeId)).toEqual([f.e3]);
    const detail = await h.request('GET', `${base()}/attendance-policies/points/${f.e3}?asOf=2026-03-31`, { token: f.hrUser });
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ asOf: '2026-03-31', windowFrom: '2026-03-02', points: 4 });
    expect(detail.body.data.events).toEqual([
      { date: '2026-03-10', kind: 'LATE', points: 1, expiresOn: '2026-04-09', policyId: detail.body.data.policyId },
      { date: '2026-03-11', kind: 'ABSENT', points: 3, expiresOn: '2026-04-10', policyId: detail.body.data.policyId },
    ]);
  });

  it('a branch-scoped HR user sees the employees of their branch only', async () => {
    const r = await h.request('GET', `${base()}/attendance-policies/points?asOf=2026-03-31`, { token: scopedHr });
    expect(r.body.data.map((row: { employeeId: string }) => row.employeeId)).toEqual([f.e2]);
    expect(r.body.meta.total).toBe(1);
    expect((await h.request('GET', `${base()}/attendance-policies/points?asOf=2026-03-31&branchId=${f.branchA}`, { token: scopedHr })).status).toBe(403);
    expect((await h.request('GET', `${base()}/attendance-policies/points/${f.e3}?asOf=2026-03-31`, { token: scopedHr })).status).toBe(404);
    expect((await h.request('GET', `${base()}/attendance-policies/overtime-summary?month=2026-05`, { token: scopedHr })).body.data.map((row: { employeeId: string }) => row.employeeId)).toEqual([f.e2]);
    // a member without attendance.view
    expect((await h.request('GET', `${base()}/attendance-policies/points`, { token: f.employeeUser })).status).toBe(403);
  });

  it('summarises overtime with the policy rates and the weekly threshold', async () => {
    const r = await h.request('GET', `${base()}/attendance-policies/overtime-summary?month=2026-05`, { token: f.hrUser });
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ month: '2026-05', total: 3 });
    const byEmployee = Object.fromEntries(r.body.data.map((row: { employeeId: string }) => [row.employeeId, row]));
    expect(byEmployee[f.e3]).toMatchObject({
      policyName: 'Oman – Office Employees', workedMinutes: 3120, regularOvertimeMinutes: 180, weeklyOffOvertimeMinutes: 300, holidayOvertimeMinutes: 0,
      weeklyOvertimeMinutes: 240, weightedOvertimeMinutes: Math.round(180 * 1.25 + 240 * 1.5 + 300 * 2), daysOverDailyMaximum: 1,
    });
    // the department policy has the default sections: no weekly threshold, no daily maximum, rate 1.25
    expect(byEmployee[f.e1]).toMatchObject({ policyName: 'Operations', regularOvertimeMinutes: 120, weeklyOvertimeMinutes: 0, weightedOvertimeMinutes: 150, daysOverDailyMaximum: 0 });
    expect((await h.request('GET', `${base()}/attendance-policies/overtime-summary?month=2026-13`, { token: f.hrUser })).status).toBe(400);
  });
});
