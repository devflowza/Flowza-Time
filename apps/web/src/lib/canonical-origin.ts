/**
 * The web app has one public address, VITE_PUBLIC_APP_URL (https://time.flowza.ai). The same Cloudflare Pages build also
 * answers on other custom domains (time.flowza.com), where nothing works properly:
 *
 *  - the API answers only the origins in its WEB_ORIGINS, so every request from another host fails as a CORS error;
 *  - Supabase Auth sends password-reset and confirmation links only to allow-listed redirect URLs and otherwise falls back
 *    to the Site URL — the reset link then opens the root of the canonical host, where the PKCE verifier the other host
 *    stored does not exist, so no session and no "choose a new password" form ever appears;
 *  - sessions, pending invitations and settings are per-origin storage.
 *
 * So any other host is sent to the same path on the canonical one before the app starts. Local development and Cloudflare
 * preview deployments (*.pages.dev) are left alone, and nothing happens when the variable is not set.
 */
export function canonicalRedirectUrl(current: { origin: string; hostname: string; pathname: string; search: string; hash: string }, canonical: string | undefined): string | null {
  if (!canonical) return null;
  let target: URL;
  try { target = new URL(canonical); } catch { return null; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (current.origin === target.origin) return null;
  const host = current.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.pages.dev')) return null;
  return `${target.origin}${current.pathname}${current.search}${current.hash}`;
}
