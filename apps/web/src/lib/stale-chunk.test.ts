import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STALE_CHUNK_RELOAD_COOLDOWN_MS,
  STALE_CHUNK_RELOAD_KEY,
  canReloadForStaleChunk,
  isStaleChunkError,
  reloadForStaleChunk,
  resetStaleChunkReloadForTests,
} from './stale-chunk';

const CHUNK = 'https://time.flowza.ai/assets/employee-new-page-BIvQk39w.js';

describe('isStaleChunkError', () => {
  it.each([
    ['Chromium', new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`)],
    ['Firefox', new TypeError(`error loading dynamically imported module: ${CHUNK}`)],
    ['Safari', new TypeError('Importing a module script failed.')],
    ['Safari, HTML served as the chunk', new TypeError("'text/html' is not a valid JavaScript MIME type.")],
    ['Vite CSS preload', new Error(`Unable to preload CSS for ${CHUNK.replace('.js', '.css')}`)],
  ])('recognises the %s message', (_browser, error) => {
    expect(isStaleChunkError(error)).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isStaleChunkError(new Error('Failed to fetch'))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError({ status: 404 })).toBe(false);
  });
});

describe('reloadForStaleChunk', () => {
  const t0 = 1_800_000_000_000;
  beforeEach(() => { sessionStorage.clear(); resetStaleChunkReloadForTests(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reloads once and remembers when, so the reloaded page can tell', () => {
    const reload = vi.fn();
    expect(reloadForStaleChunk(t0, reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY)).toBe(String(t0));
    // a second boundary (or StrictMode's second effect) in the same document does not reload again
    expect(reloadForStaleChunk(t0 + 5, reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not loop when the reload a moment ago did not help', () => {
    sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(t0));
    const reload = vi.fn();
    expect(canReloadForStaleChunk(t0 + 5_000)).toBe(false);
    expect(reloadForStaleChunk(t0 + 5_000, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again for a later deploy, once the cooldown has passed', () => {
    sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(t0));
    const reload = vi.fn();
    expect(reloadForStaleChunk(t0 + STALE_CHUNK_RELOAD_COOLDOWN_MS, reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload without sessionStorage, where a loop could not be ruled out', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const reload = vi.fn();
    expect(reloadForStaleChunk(t0, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
