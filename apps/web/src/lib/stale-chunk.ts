/**
 * Every deploy replaces the content-hashed chunks under /assets. A tab opened before the deploy still runs the old entry
 * chunk, so the next lazy page it opens asks for a file that no longer exists — and Cloudflare Pages answers that with
 * the SPA's index.html (200, text/html), which the browser refuses as a module script. The error names the old chunk and
 * reloading fixes it, because the fresh index.html points at the new chunk names.
 */
const STALE_CHUNK_MESSAGES = [
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /is not a valid javascript mime type/i, // Safari/Firefox when the HTML fallback is served as the chunk
  /unable to preload css/i, // Vite's preload helper, for the chunk's stylesheet
];

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return STALE_CHUNK_MESSAGES.some((re) => re.test(message));
}

export const STALE_CHUNK_RELOAD_KEY = 'flowza.staleChunkReloadAt';
/**
 * A reload that did not help (the chunk is really missing from the current deploy, or the network is down) fails again
 * within this window; reloading again would loop, so the reader gets a button instead.
 */
export const STALE_CHUNK_RELOAD_COOLDOWN_MS = 60_000;

let reloadRequested = false;

/**
 * Whether an automatic reload is allowed now: none this document already asked for, and none in the last cooldown window
 * (remembered in sessionStorage so it survives the reload). Without storage a reload loop cannot be ruled out, so no.
 */
export function canReloadForStaleChunk(now: number = Date.now()): boolean {
  if (reloadRequested) return true;
  try {
    const last = Number(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY) ?? 0);
    return !(Number.isFinite(last) && now - last >= 0 && now - last < STALE_CHUNK_RELOAD_COOLDOWN_MS);
  } catch {
    return false;
  }
}

/** Reloads the page to pick up the current deploy when `canReloadForStaleChunk` allows it; returns whether it did. */
export function reloadForStaleChunk(now: number = Date.now(), reload: () => void = () => window.location.reload()): boolean {
  // Several boundaries (and StrictMode's double effects) can see the same failure before the page unloads.
  if (reloadRequested) return true;
  if (!canReloadForStaleChunk(now)) return false;
  try {
    sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reloadRequested = true;
  reload();
  return true;
}

/** Test seam: forget that this document already asked for a reload. */
export function resetStaleChunkReloadForTests() {
  reloadRequested = false;
}
