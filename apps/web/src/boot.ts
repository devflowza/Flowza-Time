import { captureAuthCallback } from '@/lib/auth-callback';

/**
 * Runs before any other application module is evaluated: main.tsx imports it first, and ES modules evaluate in import
 * order. An e-mail link's parameters are read, and Supabase's error parameters taken out of the URL, before the router
 * reads its initial location at module evaluation (routes.tsx) — otherwise it keeps them and carries them through the
 * sign-in redirect (lib/auth-callback.ts).
 */
captureAuthCallback();
