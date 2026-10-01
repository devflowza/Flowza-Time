import { env } from '@/lib/env';
import { captureAuthCallback } from '@/lib/auth-callback';
import { canonicalRedirectUrl } from '@/lib/canonical-origin';

/**
 * Runs before any other application module is evaluated: main.tsx imports it first, and ES modules evaluate in import order.
 * That matters for two reads of the address bar —
 *
 *  - another host serving this build is sent to the canonical one before the Supabase client or the router start there
 *    (lib/canonical-origin.ts);
 *  - an e-mail link's parameters are read, and Supabase's error parameters taken out of the URL, before the router reads
 *    its initial location at module evaluation (routes.tsx) — otherwise it keeps them and carries them through the
 *    sign-in redirect (lib/auth-callback.ts).
 */
export const redirectingTo = canonicalRedirectUrl(window.location, env.publicAppUrl);
if (redirectingTo) window.location.replace(redirectingTo);
else captureAuthCallback();
