import { useAuth } from '@/features/auth/auth-provider';

/** True while the account still signs in with the temporary password it was seeded with (supabase/seeds/platform-admin). */
export function useTemporaryPassword(): boolean {
  const { user } = useAuth();
  return user?.user_metadata?.['password_is_temporary'] === true;
}
