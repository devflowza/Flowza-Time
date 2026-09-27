import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { randomToken, sha256Hex } from '@flowza/shared';
import { buildStatementSnapshot } from '@flowza/domain';
import { auditRows, createApiHarness, queueJobs, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
beforeAll(async () => { h = await createApiHarness(`flowza_api_stmt_${process.pid}`); f = await seedOrg(h.admin, 'stmt'); });
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;

const MONTH = '2026-08';
const FROM = '2026-08-01';
const TO = '2026-08-31';

function snapshotFor(employeeId: string, name: string) {
  return buildStatementSnapshot({
    organization: { name: 'Org stmt', timezone: 'Asia/Muscat', locale: 'en', hoursNotation: 'h.mm', timeFormat: '24h', datePattern: 'dd/MM/yyyy', codeOverrides: {} },
    period: { start: FROM, end: TO },
    employee: { id: employeeId, displayName: name, employeeNumber: 'EMP1', branchName: 'Branch A', departmentName: 'Operations', designationName: null, joiningDate: '2024-01-01', exitDate: null },
    records: [{
      date: '2026-08-03', status: 'PRESENT', flags: [], firstInAt: '2026-08-03T04:05:00Z', lastOutAt: '2026-08-03T13:00:00Z',
      workedMinutes: 535, scheduledMinutes: 540, lateMinutes: 5, earlyDepartureMinutes: 0, overtimeMinutes: 0, overtimeCategory: null, leave: null,
    }],
    leaveTypes: [],
    now: new Date('2026-09-03T05:00:00Z'),
  });
}

async function seedStatement(employeeId: string, name: string, opts: { branchId?: string; expired?: boolean } = {}): Promise<{ id: string; token: string }> {
  const secret = randomToken(32);
  const row = await h.admin
    .insertInto('attendanceStatements')
    .values({
      organizationId: f.orgId,
      employeeId,
      branchId: opts.branchId ?? f.branchA,
      periodStart: new Date(`${FROM}T00:00:00Z`),
      periodEnd: new Date(`${TO}T00:00:00Z`),
      snapshot: JSON.stringify(snapshotFor(employeeId, name)),
      status: 'ISSUED',
      tokenHash: sha256Hex(secret),
      tokenExpiresAt: opts.expired ? new Date(Date.now() - 3_600_000) : new Date(Date.now() + 30 * 86_400_000),
      emailTo: 'emp@test.local',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, token: `${f.orgId}.${secret}` };
}

describe('statements · issue', () => {
  it('gates on statement.issue, refuses unfinished months, queues the worker job and audits', async () => {
    expect((await h.request('POST', `${base()}/statements/issue`, { token: f.employeeUser, body: { month: MONTH } })).status).toBe(403);
    const current = DateTime.utc().toFormat('yyyy-MM');
    expect((await h.request('POST', `${base()}/statements/issue`, { token: f.hrAdmin, body: { month: current } })).status).toBe(400);
    const r = await h.request('POST', `${base()}/statements/issue`, { token: f.hrAdmin, body: { month: MONTH } });
    expect(r.status).toBe(202);
    expect(r.body.data).toMatchObject({ status: 'QUEUED', month: MONTH });
    const jobs = await queueJobs(h.admin, 'ISSUE_MONTHLY_STATEMENTS');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.queueName).toBe('processing');
    expect(jobs[0]!.payload).toMatchObject({ organizationId: f.orgId, month: MONTH, requestedBy: f.hrAdmin });
    expect(await auditRows(h.admin, 'statement.issue')).toHaveLength(1);
  });
});

describe('statements · public review flow', () => {
  it('rejects unknown and expired tokens without revealing anything', async () => {
    expect((await h.request('POST', '/api/portal/statements/view', { body: { token: `${f.orgId}.${randomToken(32)}` } })).status).toBe(404);
    expect((await h.request('POST', '/api/portal/statements/view', { body: { token: 'garbage-token-goes-nowhere' } })).status).toBe(404);
    const expired = await seedStatement(f.e2, 'Employee 2', { branchId: f.branchB, expired: true });
    expect((await h.request('POST', '/api/portal/statements/view', { body: { token: expired.token } })).status).toBe(409);
    await h.admin.deleteFrom('attendanceStatements').where('id', '=', expired.id).execute();
  });

  it('a comment-free signature finalises the statement immediately (EMPLOYEE_CONFIRMED)', async () => {
    const s = await seedStatement(f.e2, 'Employee 2', { branchId: f.branchB });
    const view = await h.request('POST', '/api/portal/statements/view', { body: { token: s.token } });
    expect(view.status).toBe(200);
    expect(view.body.data.snapshot.totals.requiredLabel).toBe('9.00');
    expect(view.body.data.snapshot.days).toHaveLength(31);
    const viewed = await h.admin.selectFrom('attendanceStatements').select('firstViewedAt').where('id', '=', s.id).executeTakeFirstOrThrow();
    expect(viewed.firstViewedAt).not.toBeNull();

    const bad = await h.request('POST', '/api/portal/statements/submit', { body: { token: s.token, signedName: 'Employee Two', comments: [{ date: '2026-07-01', comment: 'outside' }] } });
    expect(bad.status).toBe(400);

    const submit = await h.request('POST', '/api/portal/statements/submit', { body: { token: s.token, signedName: 'Employee Two', comments: [] } });
    expect(submit.status).toBe(200);
    expect(submit.body.data).toMatchObject({ status: 'FINALIZED', finalizedReason: 'EMPLOYEE_CONFIRMED', signedName: 'Employee Two' });
    expect((await h.request('POST', '/api/portal/statements/submit', { body: { token: s.token, signedName: 'Employee Two', comments: [] } })).status).toBe(409);
    const events = await h.admin.selectFrom('domainEvents').selectAll().where('eventType', '=', 'statement.finalized').execute();
    expect(events.some((e) => e.aggregateId === s.id)).toBe(true);
  });

  it('comments route the statement to the reporting manager and record the testimony', async () => {
    const s = await seedStatement(f.e1, 'Employee 1'); // e1's manager is e3 = managerUser's employee link
    const submit = await h.request('POST', '/api/portal/statements/submit', {
      body: { token: s.token, signedName: 'Employee One', comments: [{ date: '2026-08-03', comment: 'I signed out at 18:00, not 17:00.' }] },
    });
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('PENDING_APPROVAL');
    expect(submit.body.data.comments).toHaveLength(1);
    const row = await h.admin.selectFrom('attendanceStatements').select(['approverUserId', 'commentCount', 'signedIp']).where('id', '=', s.id).executeTakeFirstOrThrow();
    expect(row.approverUserId).toBe(f.managerUser);
    expect(row.commentCount).toBe(1);
    const ev = await h.admin.selectFrom('domainEvents').selectAll().where('eventType', '=', 'statement.approval_pending').execute();
    expect(ev.some((e) => e.aggregateId === s.id && (e.payload as { userId?: string }).userId === f.managerUser)).toBe(true);
  });
});

describe('statements · approval and admin actions', () => {
  it('the assigned manager sees their inbox and approves without any statement permission; approval is terminal', async () => {
    const inbox = await h.request('GET', `${base()}/statements?inbox=true`, { token: f.managerUser });
    expect(inbox.status).toBe(200);
    expect(inbox.body.data).toHaveLength(1);
    const id = inbox.body.data[0].id;

    expect((await h.request('POST', `${base()}/statements/${id}/approve`, { token: f.payrollUser, body: {} })).status).toBe(403);
    const ok = await h.request('POST', `${base()}/statements/${id}/approve`, { token: f.managerUser, body: { note: 'Corrected tomorrow.' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'FINALIZED', finalizedReason: 'MANAGER_APPROVED', approvalNote: 'Corrected tomorrow.' });
    expect((await h.request('POST', `${base()}/statements/${id}/approve`, { token: f.managerUser, body: {} })).status).toBe(409);
    expect((await auditRows(h.admin, 'statement.approve'))).toHaveLength(1);
  });

  it('lists, self-service visibility, resend and void behave by permission and state', async () => {
    const all = await h.request('GET', `${base()}/statements?month=${MONTH}`, { token: f.hrAdmin });
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(2);
    // hr_user holds statement.view; the employee role does not, but sees their own statement by id (RLS self scope)
    expect((await h.request('GET', `${base()}/statements`, { token: f.hrUser })).status).toBe(200);
    expect((await h.request('GET', `${base()}/statements`, { token: f.employeeUser })).status).toBe(403);
    const own = await h.admin.selectFrom('attendanceStatements').select('id').where('employeeId', '=', f.e1).executeTakeFirstOrThrow();
    expect((await h.request('GET', `${base()}/statements/${own.id}`, { token: f.employeeUser })).status).toBe(200);

    const fresh = await seedStatement(f.e3, 'Employee 3');
    const resend = await h.request('POST', `${base()}/statements/${fresh.id}/resend`, { token: f.hrAdmin, body: {} });
    expect(resend.status).toBe(202);
    expect(await queueJobs(h.admin, 'SEND_STATEMENT_EMAIL')).toHaveLength(1);
    expect((await h.request('POST', `${base()}/statements/${own.id}/resend`, { token: f.hrAdmin, body: {} })).status).toBe(409);

    const voided = await h.request('POST', `${base()}/statements/${fresh.id}/void`, { token: f.hrAdmin, body: { reason: 'Recomputing the month' } });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('VOID');
    expect((await h.request('POST', `${base()}/statements/${own.id}/void`, { token: f.hrAdmin, body: { reason: 'nope' } })).status).toBe(409);
    // a voided statement's token is dead
    expect((await h.request('POST', '/api/portal/statements/view', { body: { token: fresh.token } })).status).toBe(404);
  });
});
