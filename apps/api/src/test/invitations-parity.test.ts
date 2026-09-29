/**
 * Invitations parity (HR portal Prompt 6b, Finance B-67 … B-71, B-74): resend (old token revoked, new 7-day token, e-mail
 * queued), the public validation before sign-in (state, masked address, rate limited), acceptance with either token (single
 * use, e-mail bound, refused once revoked / expired), and FlowZa Time access on an employee profile (invite to the address the
 * administrator chose — review 5-P0-2 — with role and scope defaults, revoke = suspend without unlinking, restore, resend
 * restores a suspended login directly).
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVITATION_EMAIL_JOB_TYPE, invitationEmailDedupeKey } from '@flowza/contracts';
import { randomToken, sha256Hex } from '@flowza/shared';
import { databaseSessionRevoker } from '../lib/sessions.js';
import type { SessionRevoker } from '../deps.js';
import { INVITATION_VALIDATE_LIMIT } from '../app.js';
import { auditRows, createApiHarness, queueJobs, ROLE, seedEmployee, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const revokeSpy = vi.fn<SessionRevoker['revokeUserSessions']>((trx, input) => databaseSessionRevoker.revokeUserSessions(trx, input));
const base = () => `/api/v1/orgs/${f.orgId}`;
const validate = (token: string, ip = '203.0.113.10') => h.request('POST', '/api/v1/invitations/validate', { headers: { 'x-forwarded-for': ip }, body: { token } });
const accept = (userId: string, email: string, token: string) => h.request('POST', '/api/v1/invitations/accept', { token: `${userId}:${email}`, body: { token } });
const invitation = (id: string) => h.admin.selectFrom('invitations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_invites_${process.pid}`); f = await seedOrg(h.admin, 'invites');
  h.deps.sessions = { revokeUserSessions: revokeSpy };
  await sql`create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null, created_at timestamptz not null default now())`.execute(h.admin);
});
afterAll(async () => { await h?.close(); });
beforeEach(() => { revokeSpy.mockClear(); });

describe('resend + validate + accept', () => {
  it('an invitation queues its e-mail job (no token in the payload)', async () => {
    const r = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'queued@test.local', roleId: ROLE.employee } });
    expect(r.status).toBe(201);
    const job = (await queueJobs(h.admin, INVITATION_EMAIL_JOB_TYPE)).find((j) => j.payload['invitationId'] === r.body.data.id);
    expect(job).toMatchObject({ queueName: 'notifications', organizationId: f.orgId, payload: { organizationId: f.orgId, invitationId: r.body.data.id } });
    expect(JSON.stringify(job!.payload)).not.toContain(r.body.data.token.split('.')[1]);
  });

  it('the list shows the e-mail delivery state; a failed e-mail is queued again on request (async, audited, one pending job)', async () => {
    const r = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'bounce@test.local', roleId: ROLE.employee } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ deliveryStatus: 'queued', deliveryAttempts: 0, deliveryLastError: null });
    const id: string = r.body.data.id;
    const sendAgain = (token: string, inv = id) => h.request('POST', `${base()}/invitations/${inv}/send-email`, { token });
    const jobsOf = async () => (await queueJobs(h.admin, INVITATION_EMAIL_JOB_TYPE)).filter((j) => j.payload['invitationId'] === id);
    expect((await jobsOf())[0]).toMatchObject({ dedupeKey: invitationEmailDedupeKey(id), status: 'pending' });
    // queued (a job is pending): nothing to retry yet
    expect((await sendAgain(f.owner)).status).toBe(409);

    // the worker gave up (the job is dead-lettered, out of the live queue)
    await h.admin.deleteFrom('jobs.queue').where('jobType', '=', INVITATION_EMAIL_JOB_TYPE).where(sql<boolean>`payload->>'invitationId' = ${id}`).execute();
    await h.admin.updateTable('invitations').set({ deliveryStatus: 'failed', deliveryAttempts: 5, deliveryLastError: 'email send failed: domain not verified', deliveryLastAttemptAt: new Date() }).where('id', '=', id).execute();
    const list = await h.request('GET', `${base()}/invitations`, { token: f.hrAdmin });
    expect(list.body.data.find((i: { id: string }) => i.id === id)).toMatchObject({ deliveryStatus: 'failed', deliveryAttempts: 5, deliveryLastError: 'email send failed: domain not verified' });

    expect((await sendAgain(f.hrAdmin)).status).toBe(403); // user.view only
    const retried = await sendAgain(f.owner);
    expect(retried.status).toBe(202);
    expect(retried.body.data).toMatchObject({ status: 'QUEUED', invitation: { id, deliveryStatus: 'queued', deliveryAttempts: 0, deliveryLastError: null } });
    expect(retried.body.data.invitation.token).toBeUndefined(); // the same invitation: no new copy link
    const jobs = await jobsOf();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: retried.body.data.jobId, dedupeKey: invitationEmailDedupeKey(id), status: 'pending' });
    expect((await auditRows(h.admin, 'member.invitation_email_retried')).some((a) => a.entityId === id)).toBe(true);
    // queued again: a second click does not stack a second job
    expect((await sendAgain(f.owner)).status).toBe(409);

    // an expired invitation is resent (new invitation), not re-mailed
    await h.admin.updateTable('invitations').set({ deliveryStatus: 'failed', expiresAt: new Date(Date.now() - 60_000) }).where('id', '=', id).execute();
    expect((await sendAgain(f.owner)).status).toBe(409);
    expect((await sendAgain(f.owner, uuid())).status).toBe(404);
  });

  it('resend revokes the old token and issues a new 7-day one; validate reports each state; accept is single use', async () => {
    const first = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'Resend.Me@test.local', roleId: ROLE.employee, employeeId: f.e2 } });
    expect(first.status).toBe(201);
    expect((await h.request('POST', `${base()}/invitations/${first.body.data.id}/resend`, { token: f.hrAdmin })).status).toBe(403);
    const again = await h.request('POST', `${base()}/invitations/${first.body.data.id}/resend`, { token: f.owner });
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ email: 'Resend.Me@test.local', roleId: ROLE.employee, employeeId: f.e2 });
    expect(again.body.data.token).not.toBe(first.body.data.token);
    const days = (Date.parse(again.body.data.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9); expect(days).toBeLessThanOrEqual(7);
    const old = await invitation(first.body.data.id);
    expect(old).toMatchObject({ revokeReason: 'resent', replacedById: again.body.data.id, revokedBy: f.owner });
    expect((await auditRows(h.admin, 'member.invitation_resent')).some((a) => a.entityId === again.body.data.id)).toBe(true);
    expect((await queueJobs(h.admin, INVITATION_EMAIL_JOB_TYPE)).some((j) => j.payload['invitationId'] === again.body.data.id)).toBe(true);
    // the resent one is gone from the list, the new one is there
    const list = await h.request('GET', `${base()}/invitations`, { token: f.hrAdmin });
    expect(list.body.data.map((i: { id: string }) => i.id)).toContain(again.body.data.id);
    expect(list.body.data.map((i: { id: string }) => i.id)).not.toContain(first.body.data.id);
    // a second resend of the revoked one is refused
    expect((await h.request('POST', `${base()}/invitations/${first.body.data.id}/resend`, { token: f.owner })).status).toBe(404);

    // validate: public, masked, the employee and organisation names
    const v = await validate(again.body.data.token);
    expect(v.status).toBe(200);
    expect(v.body.data).toEqual({ state: 'valid', organizationName: 'Org invites', employeeName: 'Employee 2', emailMasked: 'R***@t***.local', expiresAt: again.body.data.expiresAt });
    expect((await validate(first.body.data.token)).body.data.state).toBe('revoked');
    expect((await validate(`${f.orgId}.${'x'.repeat(40)}`)).status).toBe(404);
    // review 5-P2-7: a malformed token gets the same 404 as an unknown one
    expect((await validate('short')).status).toBe(404);

    // accept: the old token is refused as revoked; the address must match; single use
    const invitee = uuid('c');
    await seedUser(h.admin, invitee, 'resend.me@test.local', 'Resend Me');
    const revoked = await accept(invitee, 'resend.me@test.local', first.body.data.token);
    expect(revoked.status).toBe(409); expect(revoked.body.message).toMatch(/revoked/);
    const someoneElse = uuid('c');
    await seedUser(h.admin, someoneElse, 'someone-else@test.local', 'Someone else');
    expect((await accept(someoneElse, 'someone-else@test.local', again.body.data.token)).status).toBe(403);
    const ok = await accept(invitee, 'resend.me@test.local', again.body.data.token);
    expect(ok.status).toBe(200);
    expect((await accept(invitee, 'resend.me@test.local', again.body.data.token)).status).toBe(409);
    expect((await validate(again.body.data.token)).body.data.state).toBe('accepted');
    const m = await h.admin.selectFrom('orgMemberships').select(['status', 'employeeId']).where('userId', '=', invitee).executeTakeFirstOrThrow();
    expect(m).toEqual({ status: 'active', employeeId: f.e2 });
  });

  it('the e-mailed token (hash minted by the worker) accepts the same invitation; an expired one is reported and refused', async () => {
    const inv = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'mailed@test.local', roleId: ROLE.employee } });
    const secret = randomToken(32);
    await h.admin.updateTable('invitations').set({ deliveryTokenHash: sha256Hex(secret), deliverySentAt: new Date() }).where('id', '=', inv.body.data.id).execute();
    const mailed = `${f.orgId}.${secret}`;
    expect((await validate(mailed)).body.data).toMatchObject({ state: 'valid', emailMasked: 'm***@t***.local', employeeName: null });
    const expiring = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'expired@test.local', roleId: ROLE.employee } });
    await h.admin.updateTable('invitations').set({ expiresAt: new Date(Date.now() - 60_000) }).where('id', '=', expiring.body.data.id).execute();
    expect((await validate(expiring.body.data.token)).body.data.state).toBe('expired');
    const late = uuid('c');
    await seedUser(h.admin, late, 'expired@test.local', 'Late');
    expect((await accept(late, 'expired@test.local', expiring.body.data.token)).status).toBe(409);
    const user = uuid('c');
    await seedUser(h.admin, user, 'mailed@test.local', 'Mailed');
    expect((await accept(user, 'mailed@test.local', mailed)).status).toBe(200);
    // the copied link of the same invitation is spent too: one invitation, one use
    expect((await accept(user, 'mailed@test.local', inv.body.data.token)).status).toBe(409);
  });

  it('validation is rate limited per client IP', async () => {
    const token = `${f.orgId}.${'y'.repeat(40)}`;
    let limited = 0;
    for (let i = 0; i < INVITATION_VALIDATE_LIMIT.max + 2; i += 1) if ((await validate(token, '198.51.100.7')).status === 429) limited += 1;
    expect(limited).toBe(2);
    // another address is not affected
    expect((await validate(token, '198.51.100.8')).status).toBe(404);
  });

  it('revoking keeps the row (reported as revoked) and a closed invitation no longer blocks deleting its custom role', async () => {
    const role = await h.request('POST', `${base()}/roles`, { token: f.owner, body: { key: 'kiosk_staff', name: 'Kiosk staff', permissions: ['attendance.view_own'] } });
    expect(role.status).toBe(201);
    const inv = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'kiosk@test.local', roleId: role.body.data.id } });
    expect((await h.request('DELETE', `${base()}/roles/${role.body.data.id}`, { token: f.owner })).status).toBe(409);
    expect((await h.request('DELETE', `${base()}/invitations/${inv.body.data.id}`, { token: f.owner })).status).toBe(204);
    expect((await invitation(inv.body.data.id)).revokeReason).toBe('revoked');
    expect((await validate(inv.body.data.token)).body.data.state).toBe('revoked');
    expect((await h.request('DELETE', `${base()}/invitations/${inv.body.data.id}`, { token: f.owner })).status).toBe(404);
    expect((await h.request('DELETE', `${base()}/roles/${role.body.data.id}`, { token: f.owner })).status).toBeLessThan(300);
  });
});

describe('FlowZa Time access on an employee profile', () => {
  let e4: string; let e5: string; let person: string;
  beforeAll(async () => {
    e4 = await seedEmployee(h.admin, f.orgId, f.branchB, 4);
    await h.admin.updateTable('employees').set({ email: 'four@test.local' }).where('id', '=', e4).execute();
    e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5);
    await h.admin.updateTable('employees').set({ customFields: JSON.stringify({ personalEmail: 'five.personal@test.local' }) }).where('id', '=', e5).execute();
    person = uuid('c');
    await seedUser(h.admin, person, 'four@test.local', 'Four');
  });

  it('shows the state and offers the known addresses (work, personal) as choices; reading needs user.view, writing user.manage', async () => {
    const r = await h.request('GET', `${base()}/employees/${e4}/portal-access`, { token: f.hrAdmin });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ state: 'none', membership: null, invitation: null, employeeLeft: false });
    // set without the API (no audit row): no provenance to show, nothing flagged — and nothing is pre-selected either way
    expect(r.body.data.addresses).toEqual([{ email: 'four@test.local', source: 'work', changedAt: null, changedByUserId: null, changedByName: null, recentlyChangedByOther: false }]);
    expect((await h.request('GET', `${base()}/employees/${e5}/portal-access`, { token: f.hrAdmin })).body.data.addresses).toEqual([expect.objectContaining({ email: 'five.personal@test.local', source: 'personal' })]);
    expect((await h.request('GET', `${base()}/employees/${e4}/portal-access`, { token: f.employeeUser })).status).toBe(403);
    expect((await h.request('POST', `${base()}/employees/${e4}/portal-access/invite`, { token: f.hrAdmin, body: { email: 'four@test.local' } })).status).toBe(403);
  });

  it('invite: the chosen e-mail (required), the employee role, the employee\'s own branch, the employee link; older open invitations are superseded', async () => {
    expect((await h.request('POST', `${base()}/employees/${e4}/portal-access/invite`, { token: f.owner, body: {} })).status).toBe(400);
    const r = await h.request('POST', `${base()}/employees/${e4}/portal-access/invite`, { token: f.owner, body: { email: 'four@test.local' } });
    expect(r.status).toBe(201);
    expect(r.body.data.invitation).toMatchObject({ email: 'four@test.local', roleId: ROLE.employee, allBranches: false, branchIds: [f.branchB], employeeId: e4 });
    // the existing account got an `invited` membership up-front
    expect(r.body.data.access).toMatchObject({ state: 'invited', invitation: { email: 'four@test.local', expired: false } });
    const again = await h.request('POST', `${base()}/employees/${e4}/portal-access/invite`, { token: f.owner, body: { email: 'four@test.local' } });
    expect(again.status).toBe(201);
    expect((await invitation(r.body.data.invitation.id)).revokeReason).toBe('superseded');
    // resend re-issues the open invitation
    const resent = await h.request('POST', `${base()}/employees/${e4}/portal-access/resend`, { token: f.owner });
    expect(resent.body.data).toMatchObject({ action: 'reinvited', invitation: { employeeId: e4 } });
    const ok = await accept(person, 'four@test.local', resent.body.data.invitation.token);
    expect(ok.status).toBe(200);
    expect((await h.request('GET', `${base()}/employees/${e4}/portal-access`, { token: f.owner })).body.data).toMatchObject({ state: 'active', membership: { userId: person, status: 'active' }, invitation: null });
    expect((await h.request('POST', `${base()}/employees/${e4}/portal-access/invite`, { token: f.owner, body: { email: 'four@test.local' } })).status).toBe(409);
  });

  it('revoke suspends the login WITHOUT unlinking the employee and ends its sessions; restore re-activates; resend restores directly (B-69)', async () => {
    await sql`insert into auth.sessions (user_id) values (${person}::uuid)`.execute(h.admin);
    const revoked = await h.request('POST', `${base()}/employees/${e4}/portal-access/revoke`, { token: f.owner, body: { reason: 'Left the project' } });
    expect(revoked.status).toBe(200);
    expect(revoked.body.data).toMatchObject({ state: 'suspended', membership: { status: 'suspended' } });
    const m = await h.admin.selectFrom('orgMemberships').select(['status', 'employeeId']).where('userId', '=', person).where('organizationId', '=', f.orgId).executeTakeFirstOrThrow();
    expect(m).toEqual({ status: 'suspended', employeeId: e4 });
    expect(revokeSpy.mock.calls[0]![1]).toMatchObject({ userIds: [person], reason: 'member_suspended' });
    expect((await auditRows(h.admin, 'member.portal_access_revoked')).at(0)!.reason).toBe('Left the project');
    expect((await h.request('POST', `${base()}/employees/${e4}/portal-access/revoke`, { token: f.owner, body: {} })).status).toBe(409);
    // the invitation route cannot sneak around the revocation
    expect((await h.request('POST', `${base()}/employees/${e4}/portal-access/invite`, { token: f.owner, body: { email: 'four@test.local' } })).status).toBe(409);
    const restored = await h.request('POST', `${base()}/employees/${e4}/portal-access/restore`, { token: f.owner, body: {} });
    expect(restored.body.data).toMatchObject({ state: 'active' });
    expect((await auditRows(h.admin, 'member.portal_access_restored')).length).toBe(1);
    await h.request('POST', `${base()}/employees/${e4}/portal-access/revoke`, { token: f.owner, body: {} });
    const resend = await h.request('POST', `${base()}/employees/${e4}/portal-access/resend`, { token: f.owner });
    expect(resend.body.data).toMatchObject({ action: 'restored', invitation: null, access: { state: 'active' } });
  });

  it('never restores a login while the employee has left; nobody changes their own access', async () => {
    await h.request('POST', `${base()}/employees/${e4}/portal-access/revoke`, { token: f.owner, body: {} });
    await h.admin.updateTable('employees').set({ employmentStatus: 'terminated' }).where('id', '=', e4).execute();
    expect((await h.request('POST', `${base()}/employees/${e4}/portal-access/restore`, { token: f.owner, body: {} })).status).toBe(409);
    expect((await h.request('POST', `${base()}/employees/${e4}/portal-access/invite`, { token: f.owner, body: { email: 'four@test.local' } })).status).toBe(409);
    // an owner linked to an employee cannot revoke their own access (review 5-P0-1: the member-management rule, 403)
    const own = await seedEmployee(h.admin, f.orgId, f.branchA, 9);
    await h.admin.updateTable('orgMemberships').set({ employeeId: own }).where('userId', '=', f.owner).where('organizationId', '=', f.orgId).execute();
    expect((await h.request('POST', `${base()}/employees/${own}/portal-access/revoke`, { token: f.owner, body: {} })).status).toBe(403);
    await h.admin.updateTable('orgMemberships').set({ employeeId: null }).where('userId', '=', f.owner).where('organizationId', '=', f.orgId).execute();
  });

  it('an employee without an address needs one typed in', async () => {
    const e6 = await seedEmployee(h.admin, f.orgId, f.branchA, 6);
    expect((await h.request('POST', `${base()}/employees/${e6}/portal-access/invite`, { token: f.owner, body: {} })).status).toBe(400);
    const r = await h.request('POST', `${base()}/employees/${e6}/portal-access/invite`, { token: f.owner, body: { email: 'six@test.local', allBranches: true } });
    expect(r.status).toBe(201);
    expect(r.body.data.invitation).toMatchObject({ email: 'six@test.local', allBranches: true, branchIds: [] });
  });
});
