const required = (key: string): string => {
  const v = import.meta.env[key] as string | undefined;
  if (!v) throw new Error(`Missing ${key} — copy .env.example to apps/web/.env.local`);
  return v;
};
export const env = {
  supabaseUrl: required('VITE_SUPABASE_URL'),
  supabaseAnonKey: required('VITE_SUPABASE_ANON_KEY'),
  apiUrl: (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:4000',
  /** The one public address of the web app; other hosts serving the same build redirect to it (lib/canonical-origin.ts). */
  publicAppUrl: (import.meta.env['VITE_PUBLIC_APP_URL'] as string | undefined) || undefined,
};
