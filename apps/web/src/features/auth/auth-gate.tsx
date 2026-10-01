import { useEffect } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { authCallbackAtLoad, parseAuthCallback, RESET_PATH, takeAuthLinkErrorAtLoad } from '@/lib/auth-callback';
import { useAuth } from './auth-provider';

/**
 * Above every route (routes.tsx):
 *
 *  - a session opened by a password-reset link stays on the reset page until a new password is chosen (or the person
 *    signs out) — wherever the link landed, including the Site URL Supabase falls back to, and on every path they type;
 *  - a token-hash reset link that opened another page (an e-mail template built on the bare Site URL) is taken to the
 *    reset page with its parameters, which verifies it only when the new password is submitted;
 *  - an e-mail link Supabase refused (used before — often by a mail scanner — or expired) is reported once, with the way
 *    to a new one, instead of leaving the person on the sign-in page or in the app wondering what the link did.
 */
export function AuthGate() {
  const { t } = useTranslation();
  const { recovery } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (authCallbackAtLoad().pathname === RESET_PATH) return; // the reset page explains it in place
    const error = takeAuthLinkErrorAtLoad();
    if (!error) return;
    toast.error(t('auth.linkErrorToast'), {
      description: t('auth.linkErrorToastHint'),
      duration: 20_000,
      action: { label: t('auth.requestNewLink'), onClick: () => void navigate('/auth/forgot') },
    });
  }, [t, navigate]);

  if (location.pathname !== RESET_PATH) {
    const link = parseAuthCallback(location);
    if (link.type === 'recovery' && link.tokenHash) return <Navigate to={{ pathname: RESET_PATH, search: location.search, hash: location.hash }} replace />;
    if (recovery) return <Navigate to={RESET_PATH} replace />;
  }
  return <Outlet />;
}
