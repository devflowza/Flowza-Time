import { z } from 'zod';

/**
 * Choosing a new password: the Supabase project's policy (12 characters, upper and lower case, a digit and a symbol —
 * supabase/config.toml, `auth.passwordHint`) checked before the request, so a reset link is not spent on a password the
 * server would refuse. Messages are i18n keys.
 */
export const newPasswordSchema = z
  .object({
    password: z.string()
      .min(12, 'auth.passwordTooShort')
      .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v), 'auth.passwordComplexity'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'auth.passwordMismatch' });
export type NewPasswordForm = z.infer<typeof newPasswordSchema>;

interface AuthErrorLike { code?: string; status?: number; name?: string }

const unreachable = (e: AuthErrorLike) => e.name === 'AuthRetryableFetchError' || e.status === 0;

/** The message for a failed `updateUser({ password })`. */
export function passwordUpdateErrorKey(e: AuthErrorLike): string {
  if (e.code === 'weak_password') return 'auth.passwordWeak';
  if (e.code === 'same_password') return 'auth.passwordSame';
  if (e.code === 'reauthentication_needed') return 'auth.passwordReauth';
  if (e.code === 'over_request_rate_limit' || e.status === 429) return 'auth.tooManyAttempts';
  if (unreachable(e)) return 'auth.authUnreachable';
  return 'auth.passwordUpdateFailed';
}

/**
 * A failed `verifyOtp` on a reset link: a message to show next to the form when trying again can help (no network,
 * too many attempts), or null when the link itself is spent or expired and only a new one will do.
 */
export function resetLinkRetryKey(e: AuthErrorLike): string | null {
  if (e.code === 'over_request_rate_limit' || e.status === 429) return 'auth.tooManyAttempts';
  if (unreachable(e)) return 'auth.authUnreachable';
  return null;
}
