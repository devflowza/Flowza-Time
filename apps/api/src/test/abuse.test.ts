/**
 * Abuse tests (HR portal Prompt 10 — security gate): what an adversarial member, a replaying client or a hostile upload tries,
 * end to end through the real app and Postgres (RLS on). Each block names the abuse it pins:
 *   - identifiers the client supplies (organisation, employee, user, branch) are ignored or refused;
 *   - a replayed punch is stored once; the punch time is the server's clock, never a client-supplied one; a mocked location
 *     is handled per the organisation's policy;
 *   - nobody approves their own request — as HR, as a manager, through a delegation (to oneself or to the requester) or in a
 *     bulk decision; a repeated decision is a no-op; a level that is not current cannot be decided;
 *   - the employee cannot change an approved reason, regularisation or leave;
 *   - batch endpoints refuse one item over their cap (400) before acting;
 *   - every export needs report.export and escapes the cells a spreadsheet would evaluate;
 *   - a selfie is sniffed (JPEG / PNG / WebP only, no HTML / SVG polyglots), capped at 2 MB, and stored only under the caller's
 *     own organisation / employee prefix whatever the upload is called;
 *   - an e-mail approval link is single-use, expiring, bound to its recipient and never acts on a GET.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APPROVAL_BULK_DECIDE_MAX, BULK_STATUS_MAX_ITEMS, PERMISSIONS, REGULARISATION_BULK_MAX, SELFIE_MAX_BYTES } from '@flowza/contracts';
import { issueApprovalEmailTokens, withContext } from '@flowza/database';
import { escapeSpreadsheetText, toCsvDocument } from '../lib/csv.js';
import { createApiHarness, isoToday, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let g: OrgFixture;
let e6: string; let leaveTypeId: string;
const hrLinked = uuid('c'); // an HR admin who is also an employee of the organisation (e6)
const noExport = uuid('c'); // every permission except report.export
const base = (orgId = f.orgId) => `/api/v1/orgs/${orgId}`;
const OFFICE = { lat: 23.588, lng: 58.3829 };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function setSelfService(orgId: string, patch: Record<string, unknown>): Promise<void> {
  const row = await h.admin.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', orgId).executeTakeFirstOrThrow();
  const att = (row.attendance ?? {}) as Record<string, unknown>;
  const selfService = { ...((att['selfService'] as Record<string, unknown>) ?? {}), ...patch };
  await h.admin.updateTable('organizationSettings').set({ attendance: JSON.stringify({ ...att, selfService }) }).where('organizationId', '=', orgId).execute();
}
async function clearWorkflows(): Promise<void> { await h.admin.deleteFrom('approvalWorkflows').where('organizationId', '=', f.orgId).execute(); }
async function workflow(entityType: string, steps: unknown[]): Promise<void> {
  const r = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: `${entityType} ${randomUUID().slice(0, 6)}`, entityType, steps } });
  expect(r.status).toBe(201);
}
const decide = (requestId: string, token: string, body: Record<string, unknown>) => h.request('POST', `${base()}/approvals/${requestId}/decide`, { token, body });
const bulk = (token: string, items: Array<{ requestId: string; stepNo: number }>) => h.request('POST', `${base()}/approvals/bulk-decide`, { token, body: { items, decision: 'APPROVE' } });
const requestRow = (id: string) => h.admin.selectFrom('approvalRequests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const eventCount = async (id: string) => (await h.admin.selectFrom('approvalRequestEvents').select('id').where('requestId', '=', id).execute()).length;
let weekOffset = 4;
/** A fresh future range per leave request (a Sunday, weeks ahead; the fixture's weekly off is Friday + Saturday). */
function nextRange(days = 1): { startDate: string; endDate: string } {
  weekOffset += 1;
  const d = new Date(); d.setUTCDate(d.getUTCDate() + weekOffset * 7 - d.getUTCDay());
  const startDate = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + days - 1);
  return { startDate, endDate: d.toISOString().slice(0, 10) };
}
let correctionDay = 1;
function correction(employeeId: string): Record<string, unknown> {
  correctionDay += 1;
  const day = new Date(Date.UTC(2026, 5, correctionDay)).toISOString().slice(0, 10);
  return { employeeId, attendanceDate: day, type: 'ADD_PUNCH', proposedPunchedAt: `${day}T13:05:00Z`, reason: 'Forgot to punch out' };
}
let punchSeq = 0;
const punch = (body: Record<string, unknown>, token = f.employeeUser) => h.request('POST', `${base()}/me/punch`, { token, body: { channel: 'web', idempotencyKey: `abuse-${process.pid}-${(punchSeq += 1)}`, ...body } });

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_abuse_${process.pid}`);
  f = await seedOrg(h.admin, 'abuse');
  g = await seedOrg(h.admin, 'abuse-other');
  e6 = await seedEmployee(h.admin, f.orgId, f.branchA, 6);
  await seedUser(h.admin, hrLinked, 'hr-linked-abuse@test.local', 'HR Linked');
  await seedMembership(h.admin, f.orgId, hrLinked, ROLE.hr_admin, { employeeId: e6 });
  const roleId = uuid('9');
  await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, async (trx) => {
    await trx.insertInto('roles').values({ id: roleId, organizationId: f.orgId, key: 'all_but_export', name: 'All but export', isSystem: false }).execute();
    await trx.insertInto('rolePermissions').values(PERMISSIONS.filter((p) => p !== 'report.export').map((permissionKey) => ({ roleId, permissionKey }))).execute();
  });
  await seedUser(h.admin, noExport, 'no-export-abuse@test.local', 'No Export');
  await seedMembership(h.admin, f.orgId, noExport, roleId);
  const lt = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'AL', name: 'Annual Leave', annualAllowanceDays: 30 } });
  expect(lt.status).toBe(201);
  leaveTypeId = lt.body.data.id;
});
afterAll(async () => { await h?.close(); });

describe('identifiers supplied by the client are ignored or refused', () => {
  it('a reason given in the portal is the caller\'s own: an organisation, employee or user in the body changes nothing', async () => {
    const r = await h.request('POST', `${base()}/me/attendance/notes`, {
      token: f.employeeUser,
      body: { date: isoToday(-3), category: 'absence_reason', note: 'At the clinic', employeeId: f.e2, organizationId: g.orgId, userId: f.owner, submittedBy: f.owner, requestedBy: f.owner, status: 'approved' },
    });
    expect(r.status).toBe(201);
    const row = await h.admin.selectFrom('attendanceNotes').selectAll().where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ organizationId: f.orgId, employeeId: f.e1, submittedBy: f.employeeUser, status: 'pending' });
    expect(await h.admin.selectFrom('attendanceNotes').select('id').where('organizationId', '=', g.orgId).execute()).toHaveLength(0);
  });

  it('a leave filed in the portal is the caller\'s own leave, whatever employee the body names', async () => {
    await clearWorkflows();
    const r = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId, ...nextRange(1), reason: 'Family', employeeId: f.e2, organizationId: g.orgId, status: 'APPROVED' } });
    expect(r.status).toBe(201);
    const row = await h.admin.selectFrom('leaveRecords').selectAll().where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ organizationId: f.orgId, employeeId: f.e1, status: 'PENDING' });
  });

  it('a branch-restricted caller cannot widen a report to another branch', async () => {
    const period = { from: isoToday(-10), to: isoToday(-1) };
    const named = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'late_report', format: 'csv', parameters: { ...period, branchId: f.branchA } } });
    expect(named.status).toBe(403);
    const smuggled = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'late_report', format: 'csv', parameters: { ...period, branchIds: [f.branchA, f.branchB] } } });
    expect(smuggled.status).toBe(202);
    const stored = await h.admin.selectFrom('reportRequests').select(['parameters', 'branchId']).where('id', '=', smuggled.body.data.id).executeTakeFirstOrThrow();
    const params = stored.parameters as Record<string, unknown>;
    expect(JSON.stringify(params)).not.toContain(f.branchA);
    expect(params['branchId'] ?? stored.branchId).toBe(f.branchB);
  });

  it('a bulk decision naming another organisation\'s request answers "not found" for that line and leaves it alone', async () => {
    const foreign = await h.admin.insertInto('approvalRequests').values({ organizationId: g.orgId, entityType: 'ATTENDANCE_CORRECTION', entityId: randomUUID(), branchId: g.branchA, employeeId: g.e1, status: 'PENDING' }).returning('id').executeTakeFirstOrThrow();
    const r = await bulk(f.owner, [{ requestId: foreign.id, stepNo: 1 }]);
    expect(r.status).toBe(200);
    expect(r.body.data.results[0]).toMatchObject({ requestId: foreign.id, ok: false, code: 'NOT_FOUND' });
    expect((await requestRow(foreign.id)).status).toBe('PENDING');
    // and through the organisation in the path: another organisation's routes refuse the caller before anything is read
    expect((await h.request('POST', `${base(g.orgId)}/approvals/bulk-decide`, { token: f.owner, body: { items: [{ requestId: foreign.id, stepNo: 1 }], decision: 'APPROVE' } })).status).toBe(403);
  });
});

describe('punches', () => {
  it('the same punch sent five times at once is stored once, on the caller\'s own record, at the server\'s time', async () => {
    await setSelfService(f.orgId, { webCheckIn: true, requireGeofence: 'off', duplicatePunchSeconds: 0 });
    const idempotencyKey = `abuse-replay-${process.pid}`;
    const body = { direction: 'in', channel: 'web', idempotencyKey, clientQueuedAt: '2031-01-01T00:00:00Z', punchedAt: '2031-01-01T00:00:00Z', employeeId: f.e2, organizationId: g.orgId };
    const results = await Promise.all(Array.from({ length: 5 }, () => h.request('POST', `${base()}/me/punch`, { token: f.employeeUser, body })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => r.status === 201 || r.status === 200 || r.status === 409)).toBe(true);
    const rows = await h.admin.selectFrom('attendanceRawTransactions').selectAll().where('providerTransactionId', 'like', `self:%:${idempotencyKey}`).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: f.orgId, deviceEmployeeId: f.e1, providerTransactionId: `self:${f.e1}:${idempotencyKey}` });
    // neither the queued time nor a smuggled punch time: the server's clock
    expect(Math.abs(new Date(rows[0]!.punchedAt).getTime() - Date.now())).toBeLessThan(60_000);
    // a time queued in the past is not the punch time either
    const past = await punch({ direction: 'out', clientQueuedAt: `${isoToday(-2)}T05:00:00Z` });
    expect(past.status).toBe(201);
    const pastRow = await h.admin.selectFrom('attendanceRawTransactions').select('punchedAt').where('providerTransactionId', '=', `self:${f.e1}:abuse-${process.pid}-${punchSeq}`).executeTakeFirstOrThrow();
    expect(Math.abs(new Date(pastRow.punchedAt).getTime() - Date.now())).toBeLessThan(60_000);
    expect(await h.admin.selectFrom('attendanceRawTransactions').select('id').where('organizationId', '=', g.orgId).execute()).toHaveLength(0);
    // a regularisation cannot propose a punch in the future
    const future = await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: isoToday(2), type: 'missed_punch', proposedInAt: `${isoToday(2)}T05:00:00Z`, reason: 'Pre-filling tomorrow' } });
    expect(future.status).toBe(400);
  });

  it('a mocked location is refused under the blocking policy, flagged under the flagging one, and recorded as a mock', async () => {
    const fence = await h.request('POST', `${base()}/geofences`, { token: f.hrAdmin, body: { name: 'HQ', latitude: OFFICE.lat, longitude: OFFICE.lng, radiusM: 150, enforcement: 'hard_block', accuracyThresholdM: 100 } });
    expect(fence.status).toBe(201);
    try {
      await setSelfService(f.orgId, { requireGeofence: 'block', duplicatePunchSeconds: 0 });
      // even standing in the office: a simulated fix proves nothing
      const blocked = await punch({ direction: 'in', ...OFFICE, accuracy: 5, isMock: true });
      expect(blocked.status).toBe(403);
      expect(blocked.body.details.reason).toBe('MOCK_LOCATION');
      await setSelfService(f.orgId, { requireGeofence: 'flag' });
      const flagged = await punch({ direction: 'in', ...OFFICE, accuracy: 5, isMock: true });
      expect(flagged.status).toBe(201);
      expect(flagged.body.data.flagged).toBe(true);
      const raw = await h.admin.selectFrom('attendanceRawTransactions').select('rawPayload').where('providerTransactionId', '=', `self:${f.e1}:abuse-${process.pid}-${punchSeq}`).executeTakeFirstOrThrow();
      expect(raw.rawPayload).toMatchObject({ isMock: true });
    } finally {
      await h.request('DELETE', `${base()}/geofences/${fence.body.data.id}`, { token: f.hrAdmin });
      await setSelfService(f.orgId, { requireGeofence: 'off' });
    }
  });
});

describe('nobody approves their own request', () => {
  it('as HR: an HR admin cannot decide their own leave — directly or in a bulk decision', async () => {
    await clearWorkflows();
    await workflow('LEAVE', [{ order: 1, approverType: 'HR_ADMIN' }]);
    const own = await h.request('POST', `${base()}/me/leave`, { token: hrLinked, body: { leaveTypeId, ...nextRange(1), reason: 'Own leave' } });
    expect(own.status).toBe(201);
    const id = own.body.data.approvalRequestId as string;
    const direct = await decide(id, hrLinked, { decision: 'APPROVE', stepNo: 1 });
    expect(direct.status).toBe(403);
    const inBulk = await bulk(hrLinked, [{ requestId: id, stepNo: 1 }]);
    expect(inBulk.status).toBe(200);
    expect(inBulk.body.data.results[0]).toMatchObject({ ok: false });
    expect((await requestRow(id)).status).toBe('PENDING');
    // another HR admin can (control)
    expect((await decide(id, f.hrAdmin, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('APPROVED');
  });

  it('as a manager: a line manager holding the approving role cannot decide their own request', async () => {
    await clearWorkflows();
    await workflow('LEAVE', [{ order: 1, approverType: 'ROLE', roleId: ROLE.hr_user }]);
    const own = await h.request('POST', `${base()}/me/leave`, { token: f.managerUser, body: { leaveTypeId, ...nextRange(1), reason: 'Manager leave' } });
    expect(own.status).toBe(201);
    const id = own.body.data.approvalRequestId as string;
    expect((await decide(id, f.managerUser, { decision: 'APPROVE', stepNo: 1 })).status).toBe(403);
    expect((await bulk(f.managerUser, [{ requestId: id, stepNo: 1 }])).body.data.results[0]).toMatchObject({ ok: false });
    expect((await requestRow(id)).status).toBe('PENDING');
    expect((await decide(id, f.hrUser, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('APPROVED');
  });

  it('through a delegation: never to oneself, and a delegation to the requester never seats them on their own request', async () => {
    const self = await h.request('POST', `${base()}/approval-delegations`, { token: f.hrAdmin, body: { delegateUserId: f.hrAdmin, startsOn: isoToday(-1), endsOn: isoToday(10) } });
    expect(self.status).toBe(400);
    const mgrSelf = await h.request('POST', `${base()}/approval-delegations`, { token: f.hrAdmin, body: { delegatorUserId: f.managerUser, delegateUserId: f.managerUser, startsOn: isoToday(-1), endsOn: isoToday(10) } });
    expect(mgrSelf.status).toBe(400);
    await clearWorkflows();
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    // the approver (e1's line manager) hands their approvals to the requester themself
    const d = await h.request('POST', `${base()}/approval-delegations`, { token: f.hrAdmin, body: { delegatorUserId: f.managerUser, delegateUserId: f.employeeUser, entityTypes: ['LEAVE'], startsOn: isoToday(-1), endsOn: isoToday(10) } });
    expect(d.status).toBe(201);
    try {
      const own = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId, ...nextRange(1), reason: 'Delegated to me' } });
      expect(own.status).toBe(201);
      const id = own.body.data.approvalRequestId as string;
      expect((await decide(id, f.employeeUser, { decision: 'APPROVE', stepNo: 1 })).status).toBe(403);
      expect((await bulk(f.employeeUser, [{ requestId: id, stepNo: 1 }])).body.data.results[0]).toMatchObject({ ok: false });
      expect((await requestRow(id)).status).toBe('PENDING');
      expect((await decide(id, f.managerUser, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('APPROVED');
    } finally {
      await h.request('DELETE', `${base()}/approval-delegations/${d.body.data.id}`, { token: f.hrAdmin });
    }
  });
});

describe('decisions', () => {
  it('a repeated decision is a no-op; a level that is not the current one cannot be decided', async () => {
    await clearWorkflows();
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: ROLE.hr_admin, mode: 'ALL' }, { order: 2, approverType: 'USER', userId: f.owner }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    expect(c.status).toBe(201);
    const id = c.body.data.approvalRequestId as string;
    // level 2 is not open yet
    expect((await decide(id, f.owner, { decision: 'APPROVE', stepNo: 2 })).status).toBe(409);
    expect(await requestRow(id)).toMatchObject({ status: 'PENDING', currentStep: 1 });
    const first = await decide(id, f.hrAdmin, { decision: 'APPROVE', stepNo: 1 });
    expect(first.body.data).toMatchObject({ status: 'PENDING', noop: false });
    const events = await eventCount(id);
    // the same seat again, twice at once: both are no-ops and nothing is recorded
    const again = await Promise.all([decide(id, f.hrAdmin, { decision: 'APPROVE', stepNo: 1 }), decide(id, f.hrAdmin, { decision: 'REJECT', stepNo: 1, comment: 'Changed my mind' })]);
    expect(again.map((r) => r.status)).toEqual([200, 200]);
    expect(again.map((r) => r.body.data.noop)).toEqual([true, true]);
    expect(await eventCount(id)).toBe(events);
    // the level closes with the second HR admin; the first level can no longer be decided
    expect((await decide(id, hrLinked, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'PENDING', currentStep: 2 });
    expect((await decide(id, hrLinked, { decision: 'APPROVE', stepNo: 1 })).status).toBe(409);
    expect((await bulk(hrLinked, [{ requestId: id, stepNo: 1 }])).body.data.results[0]).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(await requestRow(id)).toMatchObject({ status: 'PENDING', currentStep: 2 });
  });
});

describe('what was approved stays approved', () => {
  it('the employee cannot change an approved reason, regularisation or leave', async () => {
    await clearWorkflows();
    // a reason
    const note = await h.request('POST', `${base()}/me/attendance/notes`, { token: f.employeeUser, body: { date: isoToday(-5), category: 'absence_reason', note: 'Doctor appointment' } });
    expect(note.status).toBe(201);
    expect((await h.request('POST', `${base()}/attendance/notes/${note.body.data.id}/review`, { token: f.managerUser, body: { decision: 'approve' } })).status).toBe(200);
    const edit = await h.request('PATCH', `${base()}/me/attendance/notes/${note.body.data.id}`, { token: f.employeeUser, body: { note: 'A different story' } });
    expect(edit.status).toBe(409);
    expect(await h.admin.selectFrom('attendanceNotes').select(['note', 'status']).where('id', '=', note.body.data.id).executeTakeFirstOrThrow()).toMatchObject({ note: 'Doctor appointment', status: 'approved' });
    // a regularisation (no edit route; the withdrawal is refused once decided)
    const reg = await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: isoToday(-6), type: 'wfh_unmarked', reason: 'Worked from home' } });
    expect(reg.status).toBe(201);
    const [regReq] = await h.admin.selectFrom('approvalRequests').select('id').where('entityId', '=', reg.body.data.id).execute();
    expect((await decide(regReq!.id, f.managerUser, { decision: 'APPROVE', stepNo: 1 })).status).toBe(200);
    expect((await h.request('POST', `${base()}/me/regularisations/${reg.body.data.id}/cancel`, { token: f.employeeUser, body: { reason: 'Undo it' } })).status).toBe(409);
    expect((await h.admin.selectFrom('attendanceRegularisationRequests').select('status').where('id', '=', reg.body.data.id).executeTakeFirstOrThrow()).status).toBe('approved');
    // a leave
    const leave = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId, ...nextRange(2), reason: 'Holiday' } });
    expect(leave.status).toBe(201);
    expect((await decide(leave.body.data.approvalRequestId, f.hrAdmin, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('APPROVED');
    expect((await h.request('PATCH', `${base()}/me/leave/${leave.body.data.id}`, { token: f.employeeUser, body: { reason: 'Longer holiday', ...nextRange(5) } })).status).toBe(409);
    expect((await h.request('POST', `${base()}/me/leave/${leave.body.data.id}/withdraw`, { token: f.employeeUser, body: { reason: 'Never mind' } })).status).toBe(409);
    expect(await h.admin.selectFrom('leaveRecords').select(['status', 'reason']).where('id', '=', leave.body.data.id).executeTakeFirstOrThrow()).toMatchObject({ status: 'APPROVED', reason: 'Holiday' });
  });
});

describe('batch caps', () => {
  it('every batch endpoint refuses one item over its cap with 400, before acting', async () => {
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
    const cases: Array<{ method: string; path: string; body: unknown }> = [
      { method: 'POST', path: '/approvals/bulk-decide', body: { items: ids(APPROVAL_BULK_DECIDE_MAX + 1).map((requestId) => ({ requestId, stepNo: 1 })), decision: 'APPROVE' } },
      { method: 'POST', path: '/attendance/regularisations/bulk-decide', body: { items: ids(REGULARISATION_BULK_MAX + 1).map((id) => ({ id })), decision: 'approve' } },
      { method: 'POST', path: '/attendance/bulk-status', body: { items: ids(BULK_STATUS_MAX_ITEMS + 1).map((employeeId) => ({ employeeId, date: isoToday(-1) })), status: 'PRESENT', reason: 'Bulk' } },
      { method: 'PUT', path: '/leave-allocations', body: { rows: ids(501).map((employeeId) => ({ employeeId, leaveTypeId, year: 2026, allocatedDays: 1 })) } },
      { method: 'POST', path: '/employees/bulk', body: { action: 'set_status', employeeIds: ids(1001), employmentStatus: 'active' } },
      { method: 'POST', path: '/sync/reconcile', body: { deviceIds: ids(1001) } },
      { method: 'POST', path: `/device-groups/${randomUUID()}/members`, body: { deviceIds: ids(501) } },
      { method: 'POST', path: '/reports', body: { reportType: 'employee_attendance', format: 'csv', parameters: { from: isoToday(-7), to: isoToday(-1), employeeIds: ids(5001) } } },
    ];
    const before = await h.admin.selectFrom('approvalRequestEvents').select('id').execute();
    for (const c of cases) {
      const r = await h.request(c.method, `${base()}${c.path}`, { token: f.owner, body: c.body, headers: { 'Idempotency-Key': `cap-${randomUUID()}` } });
      expect(r.status, `${c.method} ${c.path}`).toBe(400);
      expect(r.body.code, `${c.method} ${c.path}`).toBe('VALIDATION_ERROR');
    }
    expect((await h.admin.selectFrom('approvalRequestEvents').select('id').execute()).length).toBe(before.length);
  });
});

describe('exports', () => {
  const month = isoToday(-1).slice(0, 7);
  const exportsOf = (): Array<{ method: string; path: string; body?: unknown }> => [
    { method: 'GET', path: '/approvals/history/export' },
    { method: 'GET', path: `/leave-balances/export?year=${isoToday().slice(0, 4)}` },
    { method: 'GET', path: `/attendance/regularisations/export?from=${isoToday(-30)}&to=${isoToday()}` },
    { method: 'GET', path: `/attendance/notes/report/export?from=${isoToday(-30)}&to=${isoToday()}` },
    { method: 'POST', path: '/attendance/summary/export', body: { month } },
    { method: 'GET', path: `/reports/${randomUUID()}/download` },
    { method: 'POST', path: '/employees/bulk', body: { action: 'export', format: 'csv' } },
  ];

  it('every export refuses a member holding every permission except report.export (403); the owner is served', async () => {
    for (const x of exportsOf()) {
      const opts = { ...(x.body ? { body: x.body } : {}), headers: { 'Idempotency-Key': `exp-${randomUUID()}` } };
      const refused = await h.request(x.method, `${base()}${x.path}`, { token: noExport, ...opts });
      expect(refused.status, `${x.method} ${x.path}`).toBe(403);
      const owner = await h.request(x.method, `${base()}${x.path}`, { token: f.owner, ...opts, headers: { 'Idempotency-Key': `exp-${randomUUID()}` } });
      expect(owner.status, `${x.method} ${x.path} as owner`).not.toBe(403);
      expect(owner.status, `${x.method} ${x.path} as owner`).toBeLessThan(500);
    }
    // the list is the app's: a route that exports or downloads must be added here (and gated by report.export)
    const known = new Set(exportsOf().map((x) => `${x.method} ${x.path.split('?')[0]!.replace(/[0-9a-f-]{36}/, ':id')}`));
    const routes = h.app.routes.filter((r) => /\/(export|download)(\/|$)/.test(r.path) && r.path.startsWith('/api/v1/orgs/:orgId/')).map((r) => `${r.method} ${r.path.replace('/api/v1/orgs/:orgId', '')}`);
    expect(routes.length).toBeGreaterThan(4);
    expect([...new Set(routes)].filter((r) => !known.has(r))).toEqual([]);
  });

  it('cells a spreadsheet would evaluate are exported as text (formula injection)', async () => {
    const evil = await seedEmployee(h.admin, f.orgId, f.branchA, 66);
    await h.admin.updateTable('employees').set({ displayName: '=HYPERLINK("http://evil.test","x")', firstName: '+SUM(A1)', lastName: '@cmd' }).where('id', '=', evil).execute();
    const csv = await h.request('GET', `${base()}/leave-balances/export?year=${isoToday().slice(0, 4)}`, { token: f.owner });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('\'=HYPERLINK(');
    // no cell of the file starts with = + or @ (quoted or not)
    expect(csv.text.split(/\r\n/).some((line) => /(^|,)"?[=+@]/.test(line))).toBe(false);
    // the shared helpers, character by character (the worker's renderer uses the same rule)
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) expect(escapeSpreadsheetText(`${lead}1+1`)).toBe(`'${lead}1+1`);
    expect(escapeSpreadsheetText('Normal name')).toBe('Normal name');
    expect(toCsvDocument(['=Header'], [['=1+1', -5, null]])).toBe('﻿\'=Header\r\n\'=1+1,-5,\r\n');
  });
});

describe('selfie uploads', () => {
  const send = (form: FormData, token = f.employeeUser, orgId = f.orgId) => h.app.request(`${base(orgId)}/me/selfie-checkin`, { method: 'POST', headers: { authorization: `Bearer user:${token}` }, body: form });
  const form = (bytes: Uint8Array, type: string, name: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set('direction', 'in');
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fd.set('photo', new Blob([bytes], { type }), name);
    return fd;
  };

  it('only a real JPEG / PNG / WebP of at most 2 MB, stored under the caller\'s own organisation and employee whatever it is called', async () => {
    await setSelfService(f.orgId, { webCheckIn: true, allowSelfieCheckIn: true, requireGeofence: 'off' });
    expect((await h.request('PUT', `${base()}/employees/${f.e1}/attendance-grants`, { token: f.managerUser, body: { openAttendance: true, selfieRequired: true } })).status).toBe(200);
    const stored = () => [...h.uploads.keys()];
    const before = stored().length;
    const html = Buffer.from(`<!doctype html><html><body><script>alert(document.cookie)</script>${'x'.repeat(64)}</body></html>`);
    expect((await send(form(html, 'image/png', 'selfie.png'))).status).toBe(400);
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>${'x'.repeat(64)}</svg>`);
    expect((await send(form(svg, 'image/svg+xml', 'selfie.svg'))).status).toBe(400);
    // a real PNG header followed by markup: sniffed as a polyglot and refused
    expect((await send(form(Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')]), 'image/png', 'poly.png'))).status).toBe(400);
    const huge = await send(form(Buffer.concat([PNG, Buffer.alloc(SELFIE_MAX_BYTES)]), 'image/png', 'huge.png'));
    expect(huge.status).toBe(413);
    // base64 that is not an image, and one that decodes past the cap
    expect((await h.request('POST', `${base()}/me/selfie-checkin`, { token: f.employeeUser, body: { direction: 'in', imageBase64: html.toString('base64') } })).status).toBe(400);
    // a member of another organisation, and a caller of the other organisation's route, never reach the upload
    expect((await send(form(PNG, 'image/png', 'x.png'), g.employeeUser)).status).toBe(403);
    expect((await send(form(PNG, 'image/png', 'x.png'), f.employeeUser, g.orgId)).status).toBe(403);
    expect(stored().length).toBe(before);
    // a real photo called like a path, with an organisation / employee / path in the form: stored under the caller's own prefix
    const ok = await send(form(PNG, 'image/png', `../../${g.orgId}/${g.e1}/evil.png`, { employeeId: g.e1, organizationId: g.orgId, path: '../../../etc/passwd' }));
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { data: { id: string } }).data.id;
    const row = await h.admin.selectFrom('selfieCheckins').select(['organizationId', 'employeeId', 'photoPath']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ organizationId: f.orgId, employeeId: f.e1, photoPath: `checkins/${f.orgId}/${f.e1}/${id}.png` });
    const added = stored().slice(before);
    expect(added).toEqual([`employee-photos/checkins/${f.orgId}/${f.e1}/${id}.png`]);
    expect(stored().some((k) => k.includes('..') || k.includes(g.orgId))).toBe(false);
  });
});

describe('e-mail approval links', () => {
  it('are single-use, expire, answer only their recipient, and never act on a GET', async () => {
    await clearWorkflows();
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.hrAdmin }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = c.body.data.approvalRequestId as string;
    const step = await h.admin.selectFrom('approvalSteps').select('id').where('requestId', '=', id).executeTakeFirstOrThrow();
    const pair = await h.admin.transaction().execute((trx) => issueApprovalEmailTokens(trx, { organizationId: f.orgId, requestId: id, stepId: step.id, userId: f.hrAdmin }));
    // only the hash is stored
    expect((await h.admin.selectFrom('approvalEmailTokens').select('tokenHash').where('requestId', '=', id).execute()).map((t) => t.tokenHash)).not.toContain(pair.approve);
    // what a mail scanner does (follows the link with a GET) changes nothing
    for (const path of [`${base()}/approvals/email-action?token=${pair.approve}&action=APPROVE`, `/api/v1/approvals/email-action?token=${pair.approve}&action=APPROVE`]) {
      const r = await h.request('GET', path, { token: f.hrAdmin });
      expect(r.status, path).toBeGreaterThanOrEqual(400);
    }
    expect((await requestRow(id)).status).toBe('PENDING');
    expect((await h.admin.selectFrom('approvalEmailTokens').select('usedAt').where('requestId', '=', id).execute()).every((t) => t.usedAt === null)).toBe(true);
    // somebody else's session, or the wrong action, is refused
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.owner, body: { token: pair.approve, action: 'APPROVE' } })).status).toBe(404);
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: pair.approve, action: 'REJECT' } })).status).toBe(400);
    const ok = await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: pair.approve, action: 'APPROVE' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('APPROVED');
    // single use, the sibling link included
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: pair.approve, action: 'APPROVE' } })).status).toBe(409);
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: pair.reject, action: 'REJECT' } })).status).toBe(409);
    // an expired link does nothing
    const c2 = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id2 = c2.body.data.approvalRequestId as string;
    const step2 = await h.admin.selectFrom('approvalSteps').select('id').where('requestId', '=', id2).executeTakeFirstOrThrow();
    const old = await h.admin.transaction().execute((trx) => issueApprovalEmailTokens(trx, { organizationId: f.orgId, requestId: id2, stepId: step2.id, userId: f.hrAdmin }, { now: new Date(Date.now() - 8 * 86_400_000) }));
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: old.approve, action: 'APPROVE' } })).status).toBe(409);
    expect((await requestRow(id2)).status).toBe('PENDING');
  });
});
