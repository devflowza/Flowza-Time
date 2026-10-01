import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { clearPasswordRecovery, markPasswordRecovery, passwordRecoveryUserId, subscribePasswordRecovery, watchPasswordRecovery } from './password-recovery';

const session = (id: string) => ({ user: { id } }) as unknown as Session;

describe('password recovery mark', () => {
  beforeEach(() => { localStorage.clear(); clearPasswordRecovery(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('is set by a PASSWORD_RECOVERY event and ended by signing out', () => {
    let emit: (event: AuthChangeEvent, s: Session | null) => void = () => undefined;
    watchPasswordRecovery({ onAuthStateChange: (cb) => { emit = cb; } });
    emit('INITIAL_SESSION', session('u1'));
    expect(passwordRecoveryUserId()).toBeNull();
    emit('PASSWORD_RECOVERY', session('u1'));
    expect(passwordRecoveryUserId()).toBe('u1');
    // refreshing the recovery session's token does not end it
    emit('TOKEN_REFRESHED', session('u1'));
    expect(passwordRecoveryUserId()).toBe('u1');
    emit('SIGNED_OUT', null);
    expect(passwordRecoveryUserId()).toBeNull();
  });

  it('survives a reload (localStorage) and tells subscribers, including other tabs', () => {
    const onChange = vi.fn();
    const unsubscribe = subscribePasswordRecovery(onChange);
    markPasswordRecovery('u1', 1_800_000_000_000);
    expect(JSON.parse(localStorage.getItem('flowza.passwordRecovery')!)).toEqual({ userId: 'u1', at: 1_800_000_000_000 });
    expect(onChange).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'flowza.passwordRecovery' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent('storage', { key: 'something.else' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    unsubscribe();
    clearPasswordRecovery();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('still holds for this document when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    markPasswordRecovery('u1');
    expect(passwordRecoveryUserId()).toBe('u1');
  });

  it('ignores a stored value it cannot read', () => {
    localStorage.setItem('flowza.passwordRecovery', '{not json');
    expect(passwordRecoveryUserId()).toBeNull();
  });
});
