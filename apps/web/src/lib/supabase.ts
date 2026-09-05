import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

/** Browser client: used ONLY for auth (sign-in, MFA, password reset) and realtime subscriptions. All data access goes through the API. */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  realtime: { params: { eventsPerSecond: 10 } },
});
