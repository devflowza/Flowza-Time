/**
 * The Supabase Auth parameters an e-mail link brings back to the app: `type` (recovery, signup …), `token_hash` (a link
 * that is verified only when the person acts — see docs/go-live.md §5a), `code` (a PKCE link, which only the browser that
 * asked for it can exchange) and the error Supabase Auth reports when the link was not valid any more (`otp_expired`
 * when it was used before — often by a mail scanner that opened it first — or simply expired).
 *
 * Supabase writes them to the query string or to the fragment depending on the flow, so both are read.
 */
export interface AuthLinkError { code: string; description: string }
export interface AuthCallback {
  pathname: string;
  type: string | null;
  tokenHash: string | null;
  code: string | null;
  error: AuthLinkError | null;
}

/** Where a password-reset link opens (the redirect the forgot-password page asks for, docs/go-live.md §5a). */
export const RESET_PATH = '/auth/reset';

/** The parameter names Supabase Auth uses to report a failed link; stripped from the URL once the app has read them. */
export const AUTH_LINK_ERROR_PARAMS = ['error', 'error_code', 'error_description'] as const;

function params(search: string, hash: string): URLSearchParams {
  const merged = new URLSearchParams(search);
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  // a fragment that is a route anchor (#section) rather than a parameter list carries nothing for us
  if (fragment.includes('=')) for (const [k, v] of new URLSearchParams(fragment)) if (!merged.has(k)) merged.set(k, v);
  return merged;
}

export function parseAuthCallback(url: { pathname: string; search: string; hash: string }): AuthCallback {
  const p = params(url.search, url.hash);
  const errorCode = p.get('error_code') || p.get('error');
  const description = p.get('error_description');
  return {
    pathname: url.pathname,
    type: p.get('type'),
    tokenHash: p.get('token_hash'),
    code: p.get('code'),
    error: errorCode || description ? { code: errorCode ?? 'unspecified', description: description ?? '' } : null,
  };
}

/** The same URL without Supabase's error parameters (query string and fragment), or null when it carries none. */
export function withoutAuthLinkError(url: { search: string; hash: string }): { search: string; hash: string } | null {
  const search = new URLSearchParams(url.search);
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const hash = fragment.includes('=') ? new URLSearchParams(fragment) : null;
  const had = AUTH_LINK_ERROR_PARAMS.some((k) => search.has(k) || hash?.has(k));
  if (!had) return null;
  for (const k of AUTH_LINK_ERROR_PARAMS) { search.delete(k); hash?.delete(k); }
  const s = search.toString();
  const h = hash ? hash.toString() : fragment;
  return { search: s ? `?${s}` : '', hash: h ? `#${h}` : '' };
}

let atLoad: AuthCallback | null = null;
let errorTaken = false;

/**
 * The parameters the page was opened with, read once. boot.ts reads them before the router starts: by the time a page
 * mounts, a redirect (RequireAuth → sign-in) may already have replaced the URL that carried them.
 */
export function authCallbackAtLoad(): AuthCallback {
  if (!atLoad) atLoad = parseAuthCallback(window.location);
  return atLoad;
}

/**
 * Reads the parameters once and, on any page but the reset page (which explains a failed link in place), takes Supabase's
 * error parameters out of the address bar: they would otherwise ride along through the sign-in redirect and every
 * navigation after it. The error itself is reported once by the auth gate (takeAuthLinkErrorAtLoad).
 */
export function captureAuthCallback(): AuthCallback {
  const callback = authCallbackAtLoad();
  if (callback.error && callback.pathname !== RESET_PATH) {
    const clean = withoutAuthLinkError(window.location);
    if (clean) window.history.replaceState(window.history.state, '', `${window.location.pathname}${clean.search}${clean.hash}`);
  }
  return callback;
}

/** The link error the page was opened with, handed out once (the first caller reports it; StrictMode re-runs get null). */
export function takeAuthLinkErrorAtLoad(): AuthLinkError | null {
  if (errorTaken) return null;
  errorTaken = true;
  return authCallbackAtLoad().error;
}

/** Test seam: forget what was read at load. */
export function resetAuthCallbackForTests() {
  atLoad = null;
  errorTaken = false;
}
