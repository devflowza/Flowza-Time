import { beforeEach, describe, expect, it } from 'vitest';
import type { MeDto } from '@flowza/contracts';
import { clearCachedMe, readCachedMe, storedSessionUserId, writeCachedMe } from './me-cache';

// the test env points VITE_SUPABASE_URL at http://127.0.0.1:54321, whose storage key is sb-127-auth-token
const SESSION_KEY = 'sb-127-auth-token';
const me = (id: string): MeDto => ({ user: { id, email: `${id.slice(0, 8)}@x.test`, fullName: 'X', avatarUrl: null, locale: 'en', mfaEnrolled: false, isPlatformAdmin: false }, memberships: [] });
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const session = (id: string) => localStorage.setItem(SESSION_KEY, JSON.stringify({ access_token: 't', user: { id } }));

describe('me cache', () => {
  beforeEach(() => { localStorage.clear(); clearCachedMe(); });

  it('reads the stored session subject synchronously', () => {
    expect(storedSessionUserId()).toBeNull();
    session(U1);
    expect(storedSessionUserId()).toBe(U1);
  });

  it('returns the cached answer only for the user whose session is in storage', () => {
    session(U1);
    writeCachedMe(me(U1));
    expect(readCachedMe()?.data.user.id).toBe(U1);
    expect(readCachedMe()?.at).toBeTypeOf('number');
    // another account signs in on the same browser: the old copy must not leak into their shell
    session(U2);
    expect(readCachedMe()).toBeNull();
    // no session at all
    localStorage.removeItem(SESSION_KEY);
    expect(readCachedMe()).toBeNull();
  });

  it('parses once per stored value and hands back the same object on every render', () => {
    session(U1);
    writeCachedMe(me(U1));
    const first = readCachedMe();
    expect(readCachedMe()).toBe(first);
    // a new answer (same millisecond or not) is a new object
    const renamed = me(U1); renamed.user.fullName = 'Y';
    writeCachedMe(renamed);
    expect(readCachedMe()).not.toBe(first);
    expect(readCachedMe()?.data.user.fullName).toBe('Y');
  });

  it('ignores a copy that no longer matches the contract, garbage, or a future stamp', () => {
    session(U1);
    localStorage.setItem('flowza.me', '{not json');
    expect(readCachedMe()).toBeNull();
    // an older build stored a document without the fields this build requires
    localStorage.setItem('flowza.me', JSON.stringify({ userId: U1, at: Date.now(), data: { user: { id: U1 }, memberships: [] } }));
    expect(readCachedMe()).toBeNull();
    // a clock that ran ahead must not make the copy look fresh forever
    localStorage.setItem('flowza.me', JSON.stringify({ userId: U1, at: Date.now() + 86_400_000, data: me(U1) }));
    expect(readCachedMe()!.at).toBeLessThanOrEqual(Date.now());
    clearCachedMe();
    expect(readCachedMe()).toBeNull();
  });
});
