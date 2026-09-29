/**
 * The invitation an invitee was redeeming when their new account still needed its email confirmed.
 *
 * The confirmation link is meant to bring them back to /auth/invite (emailRedirectTo), but Supabase falls back to the
 * project's Site URL whenever that URL is not allow-listed — and the invitee then lands signed in on the "create your
 * organisation" screen, the one place that cannot help them. Remembering the token here lets the shell send them back
 * to the invitation instead, however they arrive (the confirmation link, or signing in afterwards).
 *
 * Browser storage is a convenience: it can be empty or throw (private windows, blocked site data), and then the
 * invitee simply opens the invitation link again, as before. The token is single-use and bound to the invited address;
 * the invitation page forgets it as soon as it opens, so a stale or foreign token costs one redirect to an explained
 * error, never a loop.
 */
const KEY = 'flowza.pendingInvitation';
/** Invitations expire after 7 days; a remembered token older than that has nothing left to redeem. */
const MAX_AGE_MS = 7 * 86_400_000;

export function rememberPendingInvitation(token: string): void {
  try { localStorage.setItem(KEY, JSON.stringify({ token, at: Date.now() })); } catch { /* storage unavailable */ }
}

export function forgetPendingInvitation(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

/** The remembered token, or null (a pure read: safe during render). */
export function readPendingInvitation(): string | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { token?: unknown; at?: unknown };
    if (typeof v.token !== 'string' || !v.token || typeof v.at !== 'number' || Date.now() - v.at > MAX_AGE_MS) return null;
    return v.token;
  } catch { return null; }
}
