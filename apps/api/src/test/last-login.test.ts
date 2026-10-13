/**
 * "Last sign-in" (`user_profiles.last_login_at`) is sourced from GoTrue, because nothing was ever writing it.
 *
 * In production the column was NULL for every one of 20 profiles while 33 sessions were live, so the six places that
 * display it — the members table, the portal-access card, and the platform console's users, team and tenant panels —
 * all read "Never". The hook that was meant to fill it is cancelled (risk D27: it needs the Supabase Team plan), so
 * `/me` now stamps the column from `auth.users.last_sign_in_at` via `app.touch_last_login()`.
 *
 * Each test pins a property that made the reported bug possible or that the fix must not break:
 *   stamps      — a sign-in reaches the column at all (the actual defect);
 *   no rewrite  — a repeat /me writes nothing, since /me runs on every page load (updated_at is the witness);
 *   advances    — a later sign-in moves it;
 *   absent      — no sign-in time in GoTrue leaves NULL rather than erroring;
 *   isolation   — the SECURITY DEFINER function touches only the caller's row, never another user's.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, F, type TestApi } from './harness.js';

let h: TestApi;
beforeAll(async () => { h = await createTestApi('lastlogin'); }, 120_000);
afterAll(async () => { await h?.close(); });

const SIGNED_IN = '2026-10-13T09:15:00.000Z';
const LATER = '2026-10-13T18:40:00.000Z';

/** Reads straight through the admin connection: the point is what the column holds, not what an endpoint reports. */
async function profileRow(userId: string): Promise<{ lastLoginAt: Date | null; updatedAt: Date } | undefined> {
  const r = await sql<{ lastLoginAt: Date | null; updatedAt: Date }>`
    select last_login_at as "lastLoginAt", updated_at as "updatedAt" from public.user_profiles where id = ${userId}::uuid
  `.execute(h.tdb.adminDb);
  return r.rows[0];
}

const setGoTrueSignIn = (userId: string, at: string | null) =>
  sql`update auth.users set last_sign_in_at = ${at}::timestamptz where id = ${userId}::uuid`.execute(h.tdb.adminDb);

describe('last_login_at from auth.users', () => {
  it('stamps the column from the caller\'s GoTrue sign-in time', async () => {
    await setGoTrueSignIn(F.ownerA, SIGNED_IN);
    const res = await h.request('GET', '/me', { user: F.ownerA });
    expect(res.status).toBe(200);
    const row = await profileRow(F.ownerA);
    expect(row?.lastLoginAt).not.toBeNull();
    expect(new Date(row!.lastLoginAt!).toISOString()).toBe(SIGNED_IN);
  });

  it('writes nothing on a repeat call, so a page load does not rewrite the row', async () => {
    await setGoTrueSignIn(F.ownerA, SIGNED_IN);
    await h.request('GET', '/me', { user: F.ownerA });
    const before = await profileRow(F.ownerA);
    await h.request('GET', '/me', { user: F.ownerA });
    await h.request('GET', '/me', { user: F.ownerA });
    const after = await profileRow(F.ownerA);
    // updated_at is the witness: the user_profiles trigger bumps it on any UPDATE, so an unchanged value proves the
    // guard held and no write happened.
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect(new Date(after!.lastLoginAt!).toISOString()).toBe(SIGNED_IN);
  });

  it('advances when the user signs in again', async () => {
    await setGoTrueSignIn(F.ownerA, SIGNED_IN);
    await h.request('GET', '/me', { user: F.ownerA });
    await setGoTrueSignIn(F.ownerA, LATER);
    await h.request('GET', '/me', { user: F.ownerA });
    const row = await profileRow(F.ownerA);
    expect(new Date(row!.lastLoginAt!).toISOString()).toBe(LATER);
  });

  it('leaves the column NULL and still answers 200 when GoTrue has no sign-in time', async () => {
    await setGoTrueSignIn(F.hrUserA, null);
    await sql`update public.user_profiles set last_login_at = null where id = ${F.hrUserA}::uuid`.execute(h.tdb.adminDb);
    const res = await h.request('GET', '/me', { user: F.hrUserA });
    expect(res.status).toBe(200);
    expect((await profileRow(F.hrUserA))?.lastLoginAt).toBeNull();
  });

  it('touches only the caller\'s row', async () => {
    // Both users have a GoTrue sign-in time; only the one that calls /me may be stamped. The function is SECURITY
    // DEFINER, so it runs past RLS — scoping it to app.uid() is the only thing keeping it honest.
    await setGoTrueSignIn(F.ownerA, SIGNED_IN);
    await setGoTrueSignIn(F.ownerB, SIGNED_IN);
    await sql`update public.user_profiles set last_login_at = null where id in (${F.ownerA}::uuid, ${F.ownerB}::uuid)`.execute(h.tdb.adminDb);
    await h.request('GET', '/me', { user: F.ownerA });
    expect((await profileRow(F.ownerA))?.lastLoginAt).not.toBeNull();
    expect((await profileRow(F.ownerB))?.lastLoginAt).toBeNull();
  });
});
