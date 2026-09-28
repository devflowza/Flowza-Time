/**
 * Approval engine v2 review P2-6: the one-click e-mail action is a token-guessing surface, so it carries its OWN limiter —
 * 20 attempts a minute per IP AND per signed-in user, on top of the API-wide limiter — and every failed attempt is audited
 * without the token (an 8-character prefix of its sha256 identifies the link). Its own harness: the limiter's buckets are
 * per app instance, so no other suite's traffic can fill them.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APPROVAL_EMAIL_ACTION_LIMIT } from './approvals.js';
import { auditRows, createApiHarness, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_approvals_email_limit_${process.pid}`);
  f = await seedOrg(h.admin, 'aelim');
});
afterAll(async () => { await h?.close(); });

const IP_A = '198.51.100.7'; const IP_B = '198.51.100.8'; const IP_C = '198.51.100.9';
const guess = () => randomBytes(24).toString('hex');
/** One redemption attempt: `token` is the guessed link token, `user` the signed-in caller's session. */
const attempt = (token: string, ip: string, user: string) => h.request('POST', `/api/v1/orgs/${f.orgId}/approvals/email-action`, {
  token: user, headers: { 'x-forwarded-for': ip }, body: { token, action: 'APPROVE' },
});

describe('approvals — e-mail action limiter (review P2-6)', () => {
  it('P2-6 twenty guesses a minute per IP and per user, then 429; failures are audited with a hash prefix, never the token', async () => {
    expect(APPROVAL_EMAIL_ACTION_LIMIT).toEqual({ windowMs: 60_000, max: 20 });
    const tokens: string[] = [];
    for (let i = 0; i < APPROVAL_EMAIL_ACTION_LIMIT.max; i += 1) {
      const t = guess(); tokens.push(t);
      const r = await attempt(t, IP_A, f.hrAdmin);
      expect(r.status, `guess ${i + 1}`).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
    }
    // the 21st from the same IP and user never reaches the service
    const over = await attempt(guess(), IP_A, f.hrAdmin);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);

    // every failure audited: the actor, the action, the error code and 8 hex characters of the hash — nothing more
    const failed = (await auditRows(h.admin, 'approval.email_token_failed')).filter((a) => a.organizationId === f.orgId && a.actorUserId === f.hrAdmin);
    expect(failed).toHaveLength(APPROVAL_EMAIL_ACTION_LIMIT.max);
    const prefixes = new Set(tokens.map((t) => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 8)));
    for (const row of failed) {
      const v = row.newValue as { tokenHashPrefix?: string; action?: string; code?: string };
      expect(v.tokenHashPrefix).toMatch(/^[0-9a-f]{8}$/);
      expect(prefixes.has(v.tokenHashPrefix!)).toBe(true);
      expect(v).toMatchObject({ action: 'APPROVE', code: 'NOT_FOUND' });
      expect(Object.keys(v).sort()).toEqual(['action', 'code', 'tokenHashPrefix']);
      const serialised = JSON.stringify(row);
      for (const t of tokens) {
        expect(serialised).not.toContain(t);
        expect(serialised).not.toContain(createHash('sha256').update(t, 'utf8').digest('hex'));
      }
    }

    // the IP bucket is full: another user from the same address is refused
    const sameIp = await attempt(guess(), IP_A, f.hrUser);
    expect(sameIp.status).toBe(429);
    expect(sameIp.body.code).toBe('RATE_LIMITED');
    // the user bucket is full: the same user from another address is refused
    const sameUser = await attempt(guess(), IP_B, f.hrAdmin);
    expect(sameUser.status).toBe(429);
    expect(sameUser.body.code).toBe('RATE_LIMITED');
    // somebody else, somewhere else, is not affected
    const other = await attempt(guess(), IP_C, f.owner);
    expect(other.status).toBe(404);
    expect(other.body.code).toBe('NOT_FOUND');
    // the refused attempts were never audited (they never reached the service); the unaffected one was
    const after = (await auditRows(h.admin, 'approval.email_token_failed')).filter((a) => a.organizationId === f.orgId);
    expect(after.filter((a) => a.actorUserId === f.hrAdmin)).toHaveLength(APPROVAL_EMAIL_ACTION_LIMIT.max);
    expect(after.filter((a) => a.actorUserId === f.hrUser)).toHaveLength(0);
    expect(after.filter((a) => a.actorUserId === f.owner)).toHaveLength(1);
  });
});
