import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { clearCachedMe, readCachedMe, storedSessionUserId } from '@/features/me/me-cache';

interface AuthState { session: Session | null; user: User | null; loading: boolean; signOut: () => Promise<void> }
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();
  useEffect(() => {
    let mounted = true;
    // Seeded from storage so the INITIAL_SESSION event for the user already signed in is not mistaken for a switch.
    let lastUserId = storedSessionUserId();
    void supabase.auth.getSession().then(({ data }) => { if (mounted) { lastUserId = data.session?.user.id ?? null; setSession(data.session); setLoading(false); } });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      const userId = s?.user.id ?? null;
      // Signed out, or a different account signed in: everything cached — in memory and in storage — belongs to someone
      // else now, and must not be shown to the next account even for one render.
      if (userId !== lastUserId) queryClient.clear();
      if (!userId || readCachedMe()?.userId !== userId) clearCachedMe();
      lastUserId = userId;
      setSession(s); setLoading(false);
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, [queryClient]);
  const value = useMemo<AuthState>(() => ({ session, user: session?.user ?? null, loading, signOut: async () => { await supabase.auth.signOut(); } }), [session, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
