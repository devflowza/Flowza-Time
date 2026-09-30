import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { AppError, sha256Hex } from '@flowza/shared';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { deliveryErrorText, invitationEmail, sendInvitationEmail } from './index.js';

/**
 * SEND_INVITATION_EMAIL (HR portal Prompt 6b): the worker mints the e-mailed token at send time and stores only its hash;
 * accepted / revoked / expired invitations are not sent; a failing send stores nothing (the retry mints a fresh token).
 */
const ORG = '0e000000-0000-0000-0000-000000000000';
const U = { inviter: 'e0000000-0000-0000-0000-000000000001' };
const INV = { open: '0e000000-0000-0000-0000-0000000000a1', revoked: '0e000000-0000-0000-0000-0000000000a2', expired: '0e000000-0000-0000-0000-0000000000a3', ar: '0e000000-0000-0000-0000-0000000000a4', refused: '0e000000-0000-0000-0000-0000000000a5' };
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

const job = (invitationId: string, attempt: { attempts: number; maxAttempts: number } = { attempts: 1, maxAttempts: 5 }) => ({ job: { ...fakeJob('SEND_INVITATION_EMAIL', { organizationId: ORG, invitationId }, ORG), ...attempt }, deps: h.deps, log: h.deps.log, signal: new AbortController().signal });
const row = (id: string) => h.tdb.adminDb.selectFrom('invitations').select(['tokenHash', 'deliveryTokenHash', 'deliverySentAt', 'deliveryStatus', 'deliveryAttempts', 'deliveryLastError', 'deliveryNextAttemptAt', 'deliveryProvider', 'deliveryMessageId']).where('id', '=', id).executeTakeFirstOrThrow();
const logOf = (id: string) => h.tdb.adminDb.selectFrom('emailMessages').select(['status', 'provider', 'providerMessageId', 'recipient', 'kind', 'attempts', 'lastError']).where('invitationId', '=', id).executeTakeFirst();
const eventsOf = async (id: string) => (await h.tdb.adminDb.selectFrom('emailEvents as e').innerJoin('emailMessages as m', 'm.id', 'e.messageId').select('e.event').where('m.invitationId', '=', id).orderBy('e.id').execute()).map((e) => e.event);

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
    expect(r).toMatchObject({ deliveryStatus: 'sent', deliveryProvider: 'test', deliveryMessageId: `m${sent.length}`, deliveryAttempts: 1, deliveryLastError: null, deliveryNextAttemptAt: null });
    expect(mail.html).toContain('Hana HR invited you');
    // the e-mail activity log follows the row (trigger): one message, sent, with the id the provider's webhook will name
    expect(await logOf(INV.open)).toMatchObject({ status: 'sent', provider: 'test', providerMessageId: `m${sent.length}`, recipient: 'new.hire@t.local', kind: 'invitation', attempts: 1 });
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
    const r = await row(INV.ar);
    expect(r.deliveryTokenHash).toBeNull();
    // the failure is recorded in a transaction of its own: retrying, with when the queue tries again — and no internal text
    expect(r).toMatchObject({ deliveryStatus: 'retrying', deliveryAttempts: 1, deliveryLastError: 'The e-mail could not be sent (internal error).' });
    expect(r.deliveryNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await logOf(INV.ar)).toMatchObject({ status: 'retrying', attempts: 1, lastError: 'The e-mail could not be sent (internal error).', providerMessageId: null });
  });

  it('the last attempt, or a message the provider refuses, reads failed with the provider\'s reason; a later success reads sent', async () => {
    await h.tdb.adminDb.insertInto('invitations').values({ id: INV.refused, organizationId: ORG, email: 'refused@t.local', roleId: ROLE_EMPLOYEE, tokenHash: sha256Hex('copy-refused'), invitedBy: U.inviter, expiresAt: new Date(Date.now() + 86_400_000) }).execute();
    const mailer = h.deps.mailer;
    const down = new AppError('PROVIDER_ERROR', 'email send failed: service unavailable', { retryable: true });
    h.deps.mailer = { async send() { throw down; } };
    await expect(sendInvitationEmail(job(INV.refused, { attempts: 5, maxAttempts: 5 }))).rejects.toThrow('service unavailable');
    expect(await row(INV.refused)).toMatchObject({ deliveryStatus: 'failed', deliveryAttempts: 5, deliveryLastError: 'email send failed: service unavailable', deliveryNextAttemptAt: null });
    const refused = new AppError('PROVIDER_ERROR', 'email send failed: The example.com domain is not verified', { retryable: false });
    h.deps.mailer = { async send() { throw refused; } };
    await expect(sendInvitationEmail(job(INV.refused, { attempts: 1, maxAttempts: 5 }))).rejects.toThrow('not verified');
    expect(await row(INV.refused)).toMatchObject({ deliveryStatus: 'failed', deliveryAttempts: 1, deliveryLastError: 'email send failed: The example.com domain is not verified' });
    h.deps.mailer = mailer;
    expect(await sendInvitationEmail(job(INV.refused))).toEqual({ sent: true });
    expect(await row(INV.refused)).toMatchObject({ deliveryStatus: 'sent', deliveryLastError: null });
    // the log keeps the whole story of the e-mail, not just where it ended
    expect(await eventsOf(INV.refused)).toEqual(['failed', 'sent']);
    expect(await logOf(INV.refused)).toMatchObject({ status: 'sent', lastError: null });
  });

  it('never shows an internal error to the administrator', () => {
    expect(deliveryErrorText(new Error('duplicate key value violates unique constraint "x"'))).toBe('The e-mail could not be sent (internal error).');
    expect(deliveryErrorText(new AppError('PROVIDER_TIMEOUT', 'job timed out', { retryable: true }))).toBe('The e-mail provider did not answer in time.');
    expect(deliveryErrorText(new AppError('PROVIDER_ERROR', `email send failed: ${'x'.repeat(600)}`)).length).toBe(500);
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
