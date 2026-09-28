import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { sha256Hex } from '@flowza/shared';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { invitationEmail, sendInvitationEmail } from './index.js';

/**
 * SEND_INVITATION_EMAIL (HR portal Prompt 6b): the worker mints the e-mailed token at send time and stores only its hash;
 * accepted / revoked / expired invitations are not sent; a failing send stores nothing (the retry mints a fresh token).
 */
const ORG = '0e000000-0000-0000-0000-000000000000';
const U = { inviter: 'e0000000-0000-0000-0000-000000000001' };
const INV = { open: '0e000000-0000-0000-0000-0000000000a1', revoked: '0e000000-0000-0000-0000-0000000000a2', expired: '0e000000-0000-0000-0000-0000000000a3', ar: '0e000000-0000-0000-0000-0000000000a4' };
const ROLE_EMPLOYEE = '10000000-0000-0000-0000-000000000008';
let h: TestHarness;
const sent: Array<{ to: string; subject: string; html: string; text?: string }> = [];

beforeAll(async () => {
  h = await createHarness(`flowza_worker_invites_${process.pid}`, { get() { throw new Error('n/a'); }, tryGet() { return undefined; }, list() { return []; }, pushProtocols() { return []; }, pushProtocol() { return undefined; } });
  h.deps.mailer = { async send(msg) { sent.push(msg); return { id: `m${sent.length}`, provider: 'test' }; } };
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${U.inviter}::uuid, 'inviter@t.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: U.inviter, email: 'inviter@t.local', fullName: 'Hana HR' }).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'INV', legalName: 'Invites LLC', displayName: 'Invites', timezone: 'Asia/Muscat' }).execute();
  const inv = (id: string, email: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, email, roleId: ROLE_EMPLOYEE, tokenHash: sha256Hex(`copy-${id}`), invitedBy: U.inviter, expiresAt: new Date(Date.now() + 86_400_000), ...extra });
  await a.insertInto('invitations').values([
    inv(INV.open, 'new.hire@t.local'),
    inv(INV.revoked, 'gone@t.local', { revokedAt: new Date(), revokeReason: 'revoked' }),
    inv(INV.expired, 'late@t.local', { expiresAt: new Date(Date.now() - 60_000) }),
  ]).execute();
});
afterAll(async () => { await h?.close(); });

const job = (invitationId: string) => ({ job: fakeJob('SEND_INVITATION_EMAIL', { organizationId: ORG, invitationId }, ORG), deps: h.deps, log: h.deps.log, signal: new AbortController().signal });
const row = (id: string) => h.tdb.adminDb.selectFrom('invitations').select(['tokenHash', 'deliveryTokenHash', 'deliverySentAt']).where('id', '=', id).executeTakeFirstOrThrow();

describe('SEND_INVITATION_EMAIL', () => {
  it('mails a link whose token only the e-mail carries; the row keeps its hash', async () => {
    expect(await sendInvitationEmail(job(INV.open))).toEqual({ sent: true });
    const mail = sent.at(-1)!;
    expect(mail).toMatchObject({ to: 'new.hire@t.local', subject: 'You\'re invited to Invites on FlowZa Time' });
    const link = /http:\/\/web\.test\/auth\/invite\?token=([^"\s]+)/.exec(mail.text ?? '')![1]!;
    const token = decodeURIComponent(link);
    expect(token.startsWith(`${ORG}.`)).toBe(true);
    const secret = token.slice(ORG.length + 1);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const r = await row(INV.open);
    expect(r.deliveryTokenHash).toBe(sha256Hex(secret));
    expect(r.tokenHash).toBe(sha256Hex(`copy-${INV.open}`));
    expect(r.deliverySentAt).not.toBeNull();
    expect(mail.html).toContain('Hana HR invited you');
    // nothing secret in the audit trail
    const audit = await h.tdb.adminDb.selectFrom('audit.logs').selectAll().where('action', '=', 'member.invitation_emailed').execute();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain(secret);
    // a retry (or a second send) mints a new token: the earlier e-mailed link stops working
    await sendInvitationEmail(job(INV.open));
    expect((await row(INV.open)).deliveryTokenHash).not.toBe(sha256Hex(secret));
  });

  it('skips revoked, expired, accepted and unknown invitations', async () => {
    const before = sent.length;
    expect(await sendInvitationEmail(job(INV.revoked))).toEqual({ sent: false, reason: 'revoked' });
    expect(await sendInvitationEmail(job(INV.expired))).toEqual({ sent: false, reason: 'expired' });
    expect(await sendInvitationEmail(job('0e000000-0000-0000-0000-0000000000ff'))).toEqual({ sent: false, reason: 'not_found' });
    expect(sent.length).toBe(before);
    expect((await row(INV.revoked)).deliveryTokenHash).toBeNull();
  });

  it('a failing send stores no hash (the retry mints its own)', async () => {
    await h.tdb.adminDb.insertInto('invitations').values({ id: INV.ar, organizationId: ORG, email: 'ar@t.local', roleId: ROLE_EMPLOYEE, tokenHash: sha256Hex('copy-ar'), invitedBy: U.inviter, expiresAt: new Date(Date.now() + 86_400_000) }).execute();
    const mailer = h.deps.mailer;
    h.deps.mailer = { async send() { throw new Error('provider down'); } };
    await expect(sendInvitationEmail(job(INV.ar))).rejects.toThrow('provider down');
    h.deps.mailer = mailer;
    expect((await row(INV.ar)).deliveryTokenHash).toBeNull();
  });

  it('writes the e-mail in the organisation\'s language', () => {
    const m = invitationEmail({ locale: 'ar', orgName: 'شركة', inviterName: null, employeeName: 'سارة', link: 'http://web.test/auth/invite?token=x', expiresAt: new Date('2026-10-05T00:00:00Z') });
    expect(m.subject).toContain('شركة');
    expect(m.html).toContain('dir="rtl"');
    expect(m.text).toContain('2026-10-05');
    const en = invitationEmail({ locale: 'en', orgName: '<Acme>', inviterName: 'A', employeeName: null, link: 'http://web.test/x', expiresAt: new Date('2026-10-05T00:00:00Z') });
    expect(en.html).toContain('&lt;Acme&gt;');
  });
});
