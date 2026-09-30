import { describe, expect, it } from 'vitest';
import { signInErrorKey } from './sign-in-error';

describe('signInErrorKey', () => {
  it('says the password is wrong only for a credentials mismatch', () => {
    expect(signInErrorKey({ code: 'invalid_credentials', status: 400 })).toBe('auth.invalid');
    expect(signInErrorKey({ status: 400 })).toBe('auth.invalid');
  });

  it('tells an unconfirmed address, a rate limit and an unreachable service apart', () => {
    expect(signInErrorKey({ code: 'email_not_confirmed', status: 400 })).toBe('auth.emailNotConfirmed');
    expect(signInErrorKey({ code: 'over_request_rate_limit', status: 429 })).toBe('auth.tooManyAttempts');
    expect(signInErrorKey({ status: 429 })).toBe('auth.tooManyAttempts');
    expect(signInErrorKey({ name: 'AuthRetryableFetchError', status: 0 })).toBe('auth.authUnreachable');
  });
});
