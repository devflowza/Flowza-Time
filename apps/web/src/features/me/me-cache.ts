import { meDtoSchema, type MeDto } from '@flowza/contracts';
import { env } from '@/lib/env';

/**
 * The last `/me` answer for the signed-in user, kept in localStorage so the shell can render — and every page can start
 * its own requests — before the network answers. The query still refetches on load unless the copy is under a minute
 * old, and the server re-checks permissions on every call, so a stale copy can at most show a menu entry for a moment
 * longer than it should. The copy is validated against the contract on the way in, so a deploy that changes the shape
 * of `/me` simply ignores what an older build stored.
 */
const KEY = 'flowza.me';
interface CachedMe { userId: string; at: number; data: MeDto }

/** Subject of the Supabase session already in storage, read synchronously (the SDK's own accessor is async). */
export function storedSessionUserId(): string | null {
  try {
    const ref = new URL(env.supabaseUrl).hostname.split('.')[0];
    const raw = localStorage.getItem(`sb-${ref}-auth-token`);
    if (!raw) return null;
    const session = JSON.parse(raw) as { user?: { id?: string } } | null;
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// Parsed once per stored value: useMe() runs in many components, and each render only needs to compare the raw string.
let lastRaw: string | null = null;
let lastParsed: CachedMe | null = null;

/** The cached answer, only when it belongs to the user whose session is in storage and matches the current contract. */
export function readCachedMe(): CachedMe | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastParsed = null;
      const cached = JSON.parse(raw) as Partial<CachedMe>;
      const data = meDtoSchema.safeParse(cached.data);
      if (data.success && typeof cached.userId === 'string' && typeof cached.at === 'number') {
        lastParsed = { userId: cached.userId, at: Math.min(cached.at, Date.now()), data: data.data };
      }
    }
    const userId = storedSessionUserId();
    if (!lastParsed || !userId || lastParsed.userId !== userId || lastParsed.data.user.id !== userId) return null;
    return lastParsed;
  } catch {
    return null;
  }
}

export function writeCachedMe(data: MeDto): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ userId: data.user.id, at: Date.now(), data } satisfies CachedMe));
  } catch {
    // storage full or blocked: the app simply loads without the head start
  }
}

export function clearCachedMe(): void {
  lastRaw = null;
  lastParsed = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
