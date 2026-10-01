import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, LinkIcon, MailWarning } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { parseAuthCallback, RESET_PATH } from '@/lib/auth-callback';
import { AuthLayout } from './auth-layout';
import { useAuth } from './auth-provider';
import { clearPasswordRecovery } from './password-recovery';
import { MfaChallenge } from './sign-in-page';
import { newPasswordSchema, passwordUpdateErrorKey, resetLinkRetryKey, type NewPasswordForm } from './password-policy';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input, Skeleton } from '@/components/ui';

type LinkProblemKind = 'expired' | 'otherBrowser' | 'missing';

/**
 * /auth/reset — where a password-reset e-mail link opens, and the only page a session opened by one may use until a new
 * password is chosen (AuthGate). It handles every shape the link can arrive in:
 *
 *  - `?token_hash=…&type=recovery` (the e-mail template in docs/go-live.md §5a): nothing is verified until the person
 *    submits the new password, so a mail scanner that opens the link first spends nothing, and it works on any device;
 *  - `?code=…` (Supabase's default PKCE link): the client exchanged it on load when this browser asked for it — the
 *    session is then a recovery session; another browser cannot exchange it and is told so;
 *  - `?error_code=otp_expired…`: the link was used before (often by a scanner) or expired — a new one is the way out.
 *
 * A signed-in member who opens the page without a link changes their password here too.
 */
export function ResetPasswordPage() {
  const { session, loading, recovery } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const link = useMemo(() => parseAuthCallback(location), [location]);
  const [outcome, setOutcome] = useState<'done' | 'expired' | null>(null);

  if (outcome === 'done') return <PasswordChanged />;
  if (loading) return <Shell><Skeleton className="h-64 w-full max-w-sm" /></Shell>;

  const tokenHash = link.type === 'recovery' && !link.error ? link.tokenHash : null;
  let problem: LinkProblemKind | null = null;
  if (outcome === 'expired') problem = 'expired';
  else if (!recovery && !tokenHash) {
    if (link.error) problem = 'expired';
    else if (!session) problem = link.code ? 'otherBrowser' : 'missing';
  }
  if (problem) return <LinkProblem kind={problem} signedIn={!!session} />;

  return (
    <NewPassword
      tokenHash={tokenHash}
      email={session?.user.email ?? null}
      mode={recovery || tokenHash ? 'reset' : 'change'}
      onExpired={() => setOutcome('expired')}
      onDone={() => {
        setOutcome('done');
        // the link is spent: a reload must not offer it again
        void navigate(RESET_PATH, { replace: true });
      }}
    />
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <AuthLayout>{children}</AuthLayout>;
}

function NewPassword({ tokenHash, email, mode, onExpired, onDone }: { tokenHash: string | null; email: string | null; mode: 'reset' | 'change'; onExpired: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);
  // a link verified on an earlier attempt (whose password the server then refused) is not verified again: it is spent
  const verified = useRef(false);
  // an account protected by an authenticator needs aal2 before Supabase Auth changes its password (`insufficient_aal`)
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const pendingPassword = useRef<string | null>(null);
  const form = useForm<NewPasswordForm>({ resolver: zodResolver(newPasswordSchema), defaultValues: { password: '', confirm: '' } });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(async ({ password }) => {
    setError(null);
    if (tokenHash && !verified.current) {
      const { error: err } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
      if (err) {
        const retry = resetLinkRetryKey(err);
        if (retry) setError(t(retry)); else onExpired();
        return;
      }
      verified.current = true;
    }
    await update(password);
  });

  async function update(password: string) {
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err?.code === 'insufficient_aal') {
      const factors = await supabase.auth.mfa.listFactors();
      const totp = factors.data?.totp[0];
      if (totp) { pendingPassword.current = password; setMfaFactorId(totp.id); return; }
    }
    if (err) { setError(t(passwordUpdateErrorKey(err))); return; }
    clearPasswordRecovery();
    // Whoever else holds a session on this account (the reason for many resets) is signed out; this one stays.
    void supabase.auth.signOut({ scope: 'others' }).catch(() => undefined);
    onDone();
  }

  const cancel = async () => {
    await signOut();
    void navigate('/auth/sign-in', { replace: true });
  };

  if (mfaFactorId) {
    return <MfaChallenge factorId={mfaFactorId} onDone={() => {
      const password = pendingPassword.current;
      pendingPassword.current = null;
      setMfaFactorId(null);
      if (password) void update(password);
    }} />;
  }

  return (
    <Shell>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t(mode === 'reset' ? 'auth.resetTitle' : 'auth.changePasswordTitle')}</CardTitle>
          <CardDescription>
            {mode === 'reset'
              ? (email ? t('auth.resetHintFor', { email }) : t('auth.resetHint'))
              : t('auth.changePasswordHint', { email: email ?? '' })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <FormField label={t('auth.newPassword')} htmlFor="password" hint={t('auth.passwordHint')} error={errors.password?.message ? t(errors.password.message) : undefined}>
              <Input id="password" type="password" dir="ltr" autoComplete="new-password" autoFocus {...form.register('password')} aria-invalid={!!errors.password} />
            </FormField>
            <FormField label={t('auth.confirmPassword')} htmlFor="confirm" error={errors.confirm?.message ? t(errors.confirm.message) : undefined}>
              <Input id="confirm" type="password" dir="ltr" autoComplete="new-password" {...form.register('confirm')} aria-invalid={!!errors.confirm} />
            </FormField>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>{t('auth.setPassword')}</Button>
          </form>
          <div className="mt-4 text-center text-sm">
            {mode === 'reset' && email ? (
              <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => void cancel()}>{t('auth.cancelReset')}</button>
            ) : mode === 'reset' ? (
              <Link to="/auth/sign-in" className="text-primary hover:underline">{t('auth.signIn')}</Link>
            ) : (
              <Link to="/" className="text-primary hover:underline">{t('auth.backToApp')}</Link>
            )}
          </div>
        </CardContent>
      </Card>
    </Shell>
  );
}

function PasswordChanged() {
  const { t } = useTranslation();
  return (
    <Shell>
      <Card className="w-full max-w-sm" role="status">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl"><CheckCircle2 className="size-5 text-emerald-600" aria-hidden /> {t('auth.passwordChangedTitle')}</CardTitle>
          <CardDescription>{t('auth.passwordChangedHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full"><Link to="/" replace>{t('auth.continue')}</Link></Button>
        </CardContent>
      </Card>
    </Shell>
  );
}

const PROBLEM_KEYS: Record<LinkProblemKind, { title: string; hint: string }> = {
  expired: { title: 'auth.linkExpiredTitle', hint: 'auth.linkExpiredHint' },
  otherBrowser: { title: 'auth.linkOtherBrowserTitle', hint: 'auth.linkOtherBrowserHint' },
  missing: { title: 'auth.linkMissingTitle', hint: 'auth.linkMissingHint' },
};

function LinkProblem({ kind, signedIn }: { kind: LinkProblemKind; signedIn: boolean }) {
  const { t } = useTranslation();
  const Icon = kind === 'missing' ? LinkIcon : MailWarning;
  return (
    <Shell>
      <Card className="w-full max-w-sm" data-testid="reset-link-problem" data-kind={kind}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl"><Icon className="size-5 text-amber-600" aria-hidden /> {t(PROBLEM_KEYS[kind].title)}</CardTitle>
          <CardDescription>{t(PROBLEM_KEYS[kind].hint)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild className="w-full"><Link to="/auth/forgot">{t('auth.requestNewLink')}</Link></Button>
          <div className="text-center text-sm">
            {signedIn
              ? <Link to="/" className="text-primary hover:underline">{t('auth.backToApp')}</Link>
              : <Link to="/auth/sign-in" className="text-primary hover:underline">{t('auth.signIn')}</Link>}
          </div>
        </CardContent>
      </Card>
    </Shell>
  );
}
