import { describe, expect, it } from 'vitest';
import { newPasswordSchema, passwordUpdateErrorKey, resetLinkRetryKey } from './password-policy';

const issues = (password: string, confirm = password) => {
  const r = newPasswordSchema.safeParse({ password, confirm });
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('newPasswordSchema', () => {
  it("accepts a password the project's policy accepts", () => {
    expect(issues('Sup3rSecret!pass')).toEqual([]);
  });

  it('refuses what Supabase Auth would refuse, before a reset link is spent on it', () => {
    expect(issues('Sh0rt!')).toContain('auth.passwordTooShort');
    expect(issues('alllowercase123!')).toEqual(['auth.passwordComplexity']);
    expect(issues('NoDigitsHere!!!!')).toEqual(['auth.passwordComplexity']);
    expect(issues('NoSymbols1234567')).toEqual(['auth.passwordComplexity']);
    expect(issues('Sup3rSecret!pass', 'Sup3rSecret!pasS')).toEqual(['auth.passwordMismatch']);
  });
});

describe('password errors', () => {
  it('names what the server refused', () => {
    expect(passwordUpdateErrorKey({ code: 'weak_password', status: 422 })).toBe('auth.passwordWeak');
    expect(passwordUpdateErrorKey({ code: 'same_password', status: 422 })).toBe('auth.passwordSame');
    expect(passwordUpdateErrorKey({ code: 'reauthentication_needed' })).toBe('auth.passwordReauth');
    expect(passwordUpdateErrorKey({ status: 429 })).toBe('auth.tooManyAttempts');
    expect(passwordUpdateErrorKey({ name: 'AuthRetryableFetchError', status: 0 })).toBe('auth.authUnreachable');
    expect(passwordUpdateErrorKey({ code: 'unexpected_failure', status: 500 })).toBe('auth.passwordUpdateFailed');
  });

  it('tells a spent or expired link (only a new one helps) from a failure worth retrying', () => {
    expect(resetLinkRetryKey({ code: 'otp_expired', status: 403 })).toBeNull();
    expect(resetLinkRetryKey({ status: 400 })).toBeNull();
    expect(resetLinkRetryKey({ status: 429 })).toBe('auth.tooManyAttempts');
    expect(resetLinkRetryKey({ name: 'AuthRetryableFetchError', status: 0 })).toBe('auth.authUnreachable');
  });
});
