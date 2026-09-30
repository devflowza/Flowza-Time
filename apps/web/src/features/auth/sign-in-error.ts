/**
 * The message key for a failed `signInWithPassword`.
 *
 * Every failure used to read "Invalid email or password." — including an account whose email was never confirmed, a
 * rate-limited burst of attempts and a network that never reached Supabase at all. People then reset a password that
 * was fine, or created the account a second time. Only a real credentials mismatch says the password is wrong now.
 */
export function signInErrorKey(error: { code?: string; status?: number; name?: string }): string {
  if (error.code === 'email_not_confirmed') return 'auth.emailNotConfirmed';
  if (error.code === 'over_request_rate_limit' || error.status === 429) return 'auth.tooManyAttempts';
  // supabase-js reports a request that never got an answer as AuthRetryableFetchError (status 0)
  if (error.name === 'AuthRetryableFetchError' || error.status === 0) return 'auth.authUnreachable';
  return 'auth.invalid';
}
