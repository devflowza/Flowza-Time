/**
 * E-mail activity log (migration 20260930000500): the invitation e-mail an administrator issues shows up in the log as it
 * moves (queued → sent → delivered / bounced), with its timeline; the provider webhook is signature-verified, idempotent and
 * off without its secret; the summary flags e-mails no worker picked up; the log is for org-wide audit viewers only.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, ROLE, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
let h: ApiHarness; let f: OrgFixture; let other: OrgFixture;
let auditorBranchA: string;
const base = (org = f.orgId) => `/api/v1/orgs/${org}/email-log`;

function signed(body: unknown, opts: { id?: string; secret?: string; at?: number } = {}) {
  const raw = JSON.stringify(body);
  const id = opts.id ?? `msg_${randomBytes(8).toString('hex')}`;
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const key = Buffer.from((opts.secret ?? SECRET).slice('whsec_'.length), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return { raw, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` } };
}
const webhook = (body: unknown, opts: Parameters<typeof signed>[1] = {}) => { const s = signed(body, opts); return h.request('POST', '/webhooks/email/resend', { raw: s.raw, headers: s.headers }); };
const resendEvent = (type: string, emailId: string, data: Record<string, unknown> = {}) => ({ type, created_at: new Date().toISOString(), data: { email_id: emailId, created_at: new Date().toISOString(), to: ['x@test.local'], subject: 'S', ...data } });

/** What the worker writes when the provider accepted the invitation e-mail (the log follows through its trigger). */
async function markSent(invitationId: string, messageId: string) {
  await h.admin.updateTable('invitations').set({ deliveryStatus: 'sent', deliveryAttempts: 1, deliveryProvider: 'resend', deliveryMessageId: messageId, deliverySentAt: new Date() }).where('id', '=', invitationId).execute();
}
async function invite(email: string, org: OrgFixture = f): Promise<string> {
  const r = await h.request('POST', `/api/v1/orgs/${org.orgId}/invitations`, { token: org.owner, body: { email, roleId: ROLE.employee } });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_email_log_${process.pid}`, { config: { RESEND_WEBHOOK_SECRET: SECRET } });
  f = await seedOrg(h.admin, 'maillog'); other = await seedOrg(h.admin, 'maillog-other');
  auditorBranchA = uuid('c');
  await seedUser(h.admin, auditorBranchA, 'auditor-branch@test.local', 'Branch Auditor');
  await seedMembership(h.admin, f.orgId, auditorBranchA, ROLE.auditor, { branchIds: [f.branchA] });
});
afterAll(async () => { await h?.close(); });

describe('the log follows an invitation e-mail', () => {
  it('queued → sent → delivered, with its timeline; a redelivered event is recorded once; a click keeps no link', async () => {
    const id = await invite('new.hire@maillog.test');
    let list = await h.request('GET', base(), { token: f.owner, headers: {} });
    expect(list.status).toBe(200);
    const queued = list.body.data.find((m: { invitationId: string }) => m.invitationId === id);
    expect(queued).toMatchObject({ kind: 'invitation', category: 'invitation', recipient: 'new.hire@maillog.test', status: 'queued', attempts: 0, providerMessageId: null });

    await markSent(id, 're_msg_1');
    const delivered = resendEvent('email.delivered', 're_msg_1');
    const first = await webhook(delivered, { id: 'evt_delivered_1' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, result: 'recorded' });
    expect((await webhook(delivered, { id: 'evt_delivered_1' })).body).toEqual({ ok: true, result: 'duplicate' });
    expect((await webhook(resendEvent('email.opened', 're_msg_1'))).body.result).toBe('recorded');
    const click = await webhook(resendEvent('email.clicked', 're_msg_1', { click: { link: 'https://web.test/auth/invite?token=secret-token', timestamp: new Date().toISOString() } }));
    expect(click.body.result).toBe('recorded');

    const detail = await h.request('GET', `${base()}/${queued.id}`, { token: f.owner });
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ status: 'delivered', provider: 'resend', providerMessageId: 're_msg_1', attempts: 1 });
    expect(detail.body.data.deliveredAt).not.toBeNull();
    expect(detail.body.data.openedAt).not.toBeNull();
    expect(detail.body.data.events.map((e: { event: string }) => e.event)).toEqual(['queued', 'sent', 'delivered', 'opened', 'clicked']);
    expect(JSON.stringify(detail.body.data)).not.toContain('secret-token');

    list = await h.request('GET', base(), { token: f.owner, headers: {} });
    expect(list.body.data.find((m: { id: string }) => m.id === queued.id).status).toBe('delivered');
  });

  it('a bounce reads bounced with the provider\'s reason; filters by status and by recipient', async () => {
    const id = await invite('typo@maillog.test');
    await markSent(id, 're_msg_bounce');
    const r = await webhook(resendEvent('email.bounced', 're_msg_bounce', { bounce: { type: 'Permanent', subType: 'General', message: 'The recipient\'s mailbox does not exist.' } }));
    expect(r.body.result).toBe('recorded');
    const bounced = await h.request('GET', `${base()}?status=bounced`, { token: f.hrAdmin });
    expect(bounced.status).toBe(200);
    expect(bounced.body.data).toHaveLength(1);
    expect(bounced.body.data[0]).toMatchObject({ recipient: 'typo@maillog.test', status: 'bounced', lastError: 'Permanent / General: The recipient\'s mailbox does not exist.' });
    const problemsOrDelivered = await h.request('GET', `${base()}?status=failed,bounced,complained,delivered`, { token: f.owner });
    expect(problemsOrDelivered.body.data.map((m: { status: string }) => m.status).sort()).toEqual(['bounced', 'delivered']);
    expect((await h.request('GET', `${base()}?status=bounced,nonsense`, { token: f.owner })).status).toBe(400);
    const search = await h.request('GET', `${base()}?search=TYPO@`, { token: f.owner });
    expect(search.body.data.map((m: { recipient: string }) => m.recipient)).toEqual(['typo@maillog.test']);
    expect((await h.request('GET', `${base()}?invitationId=${id}`, { token: f.owner })).body.meta.total).toBe(1);
  });

  it('an event for a message this system never sent, or of a type the log does not keep, is acknowledged and not recorded', async () => {
    expect((await webhook(resendEvent('email.delivered', 're_unknown'))).body).toEqual({ ok: true, result: 'unknown_message' });
    expect((await webhook(resendEvent('email.sent', 're_msg_1'))).body).toEqual({ ok: true, result: 'ignored' });
    expect((await webhook({ type: 'domain.updated', created_at: new Date().toISOString(), data: {} })).body).toEqual({ ok: true, result: 'ignored' });
  });
});

describe('the webhook refuses what it cannot trust', () => {
  it('a wrong secret, a stale timestamp, a missing signature or a body that is not the signed one: 401', async () => {
    const body = resendEvent('email.bounced', 're_msg_1');
    expect((await webhook(body, { secret: `whsec_${randomBytes(24).toString('base64')}` })).status).toBe(401);
    expect((await webhook(body, { at: Date.now() - 10 * 60_000 })).status).toBe(401);
    expect((await h.request('POST', '/webhooks/email/resend', { body })).status).toBe(401);
    const s = signed(body);
    expect((await h.request('POST', '/webhooks/email/resend', { raw: s.raw.replace('re_msg_1', 're_msg_2'), headers: s.headers })).status).toBe(401);
    // nothing of the above reached the log
    const msg = await h.admin.selectFrom('emailMessages').select(['status']).where('providerMessageId', '=', 're_msg_1').executeTakeFirstOrThrow();
    expect(msg.status).toBe('delivered');
  });

  it('a signed body that is not an event: 400', async () => {
    expect((await webhook({ nope: true })).status).toBe(400);
  });

  it('is off (404) until RESEND_WEBHOOK_SECRET is set', async () => {
    const config = h.deps.config as { RESEND_WEBHOOK_SECRET?: string };
    config.RESEND_WEBHOOK_SECRET = undefined;
    try {
      expect((await webhook(resendEvent('email.delivered', 're_msg_1'))).status).toBe(404);
    } finally {
      config.RESEND_WEBHOOK_SECRET = SECRET;
    }
  });
});

describe('summary', () => {
  it('counts the period by status and flags e-mails no worker picked up', async () => {
    const id = await invite('stuck@maillog.test');
    let s = await h.request('GET', `${base()}/summary`, { token: f.owner });
    expect(s.status).toBe(200);
    expect(s.body.data).toMatchObject({ stalled: 0, consoleSent: 0 });
    expect(s.body.data.byStatus).toMatchObject({ delivered: 1, bounced: 1, queued: 1 });
    expect(s.body.data.total).toBe(3);
    // ten minutes later nothing has sent it: the worker is not running (or not on this build)
    await h.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx); // past the updated_at trigger: a fixture, not a write
      await sql`update public.email_messages set updated_at = now() - interval '10 minutes', created_at = now() - interval '10 minutes' where invitation_id = ${id}::uuid`.execute(trx);
    });
    s = await h.request('GET', `${base()}/summary`, { token: f.owner });
    expect(s.body.data.stalled).toBe(1);
    expect(s.body.data.oldestStalledAt).not.toBeNull();
    // a console "send" never left the server
    await h.admin.updateTable('invitations').set({ deliveryStatus: 'sent', deliveryAttempts: 1, deliveryProvider: 'console', deliveryMessageId: null, deliverySentAt: new Date() }).where('id', '=', id).execute();
    s = await h.request('GET', `${base()}/summary`, { token: f.owner });
    expect(s.body.data).toMatchObject({ stalled: 0, consoleSent: 1 });
    expect((await h.request('GET', `${base()}/summary?from=2026-09-30T10:00:00Z&to=2026-09-29T10:00:00Z`, { token: f.owner })).status).toBe(400);
  });
});

describe('who reads the log', () => {
  it('org-wide audit viewers of this organisation only', async () => {
    await invite('other-org@maillog.test', other);
    const mine = await h.request('GET', base(), { token: f.owner });
    expect(mine.body.data.every((m: { organizationId: string }) => m.organizationId === f.orgId)).toBe(true);
    expect(mine.body.data.map((m: { recipient: string }) => m.recipient)).not.toContain('other-org@maillog.test');
    expect((await h.request('GET', base(), { token: f.employeeUser })).status).toBe(403);
    expect((await h.request('GET', base(), { token: f.hrUser })).status).toBe(403);
    const scoped = await h.request('GET', base(), { token: auditorBranchA });
    expect(scoped.status).toBe(403);
    expect(scoped.body.message).toContain('all branches');
    expect((await h.request('GET', `${base()}/summary`, { token: auditorBranchA })).status).toBe(403);
    // another organisation's message by id: not found (RLS), never its content
    const theirs = await h.admin.selectFrom('emailMessages').select('id').where('organizationId', '=', other.orgId).executeTakeFirstOrThrow();
    expect((await h.request('GET', `${base()}/${theirs.id}`, { token: f.owner })).status).toBe(404);
    expect((await h.request('GET', `${base()}/not-a-uuid`, { token: f.owner })).status).toBe(404);
    expect((await h.request('GET', base(other.orgId), { token: f.owner })).status).toBe(403);
  });
});
