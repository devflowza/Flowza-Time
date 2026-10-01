import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

/**
 * A session that a password-reset link created.
 *
 * Opening the link signs the person in — that is how Supabase Auth proves they own the address — but they came to choose
 * a new password, not to use the app. Until they do, the app keeps them on /auth/reset (routes.tsx), wherever the link
 * landed and in every tab, instead of dropping them into the portal on a password they never set. The mark is kept per
 * user in localStorage (the recovery session itself lives there too) and ends when the password is changed, the person
 * signs out, or signs in with a password.
 */
const KEY = 'flowza.passwordRecovery';
interface Mark { userId: string; at: number }

let memory: string | null = null; // storage blocked (private mode, policy): the mark still holds for this document
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

function readRaw(): string | null {
  try { return localStorage.getItem(KEY); } catch { return memory; }
}

/** The user whose recovery session is waiting for a new password, if any. */
export function passwordRecoveryUserId(): string | null {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const mark = JSON.parse(raw) as Partial<Mark> | null;
    return typeof mark?.userId === 'string' ? mark.userId : null;
  } catch {
    return null;
  }
}

export function markPasswordRecovery(userId: string, now: number = Date.now()) {
  const raw = JSON.stringify({ userId, at: now } satisfies Mark);
  memory = raw;
  try { localStorage.setItem(KEY, raw); } catch { /* kept in memory */ }
  emit();
}

export function clearPasswordRecovery() {
  memory = null;
  try { localStorage.removeItem(KEY); } catch { /* nothing stored */ }
  emit();
}

/** For useSyncExternalStore: changes in this tab, and in other tabs through the storage event. */
export function subscribePasswordRecovery(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) onChange(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(onChange); window.removeEventListener('storage', onStorage); };
}

interface AuthEvents { onAuthStateChange(cb: (event: AuthChangeEvent, session: Session | null) => void): unknown }

/**
 * Follows the client's auth events. Called once by main.tsx right after the client exists and before the first render:
 * the client reports PASSWORD_RECOVERY while it initialises (a PKCE link exchanged on load), which can be before any
 * component has subscribed.
 */
export function watchPasswordRecovery(auth: AuthEvents) {
  auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' && session) markPasswordRecovery(session.user.id);
    else if (event === 'SIGNED_OUT') clearPasswordRecovery();
  });
}
