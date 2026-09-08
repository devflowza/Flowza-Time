import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { api, ApiError } from '@/lib/api-client';
import { meQueryKey } from '@/features/me/use-me';
import { useAuth } from './auth-provider';
import { invitationUrl } from './invitation-url';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input } from '@/components/ui';
import { AuthLayout } from './auth-layout';

/**
 * Redeems an invitation token.
 *
 * `POST /invitations/accept` requires an authenticated caller — it binds the invitation to the caller's email — so an
 * invitee who has no account yet cannot use it directly. This page is the missing half: it authenticates first (sign
 * in, or sign up for someone who has never had an account) and then redeems the token, which is what makes a brand
 * new owner able to onboard at all.
 *
 * It is deliberately the only route that can create an account. Signup is otherwise not exposed anywhere in the app,
 * so gating it behind a token keeps registration invitation-only even while the Supabase project still allows public
 * signup.
 */
const schema = z
  .object({
    email: z.email(),
    password: z.string().min(1, 'required'),
    mode: z.enum(['signIn', 'signUp']),
  })
  // The 12-character minimum is a rule for choosing a NEW password, so it must not gate signing in with an existing
  // one — both live accounts predate the policy and would be locked out of their own invitation. A .refine() cannot
  // express this: it only ever adds issues, so a flat password: z.string().min(12) stays failed in either mode.
  .superRefine((v, ctx) => {
    if (v.mode === 'signUp' && v.password.length < 12) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'tooShort' });
    }
  });
type Form = z.infer<typeof schema>;

type Phase = { kind: 'form' } | { kind: 'accepting' } | { kind: 'confirmEmail'; email: string } | { kind: 'done' };

export function AcceptInvitationPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token');
  const { session } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signUp');

  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '', mode: 'signUp' } });

  // One latch shared by BOTH entry points. supabase-js resolves signIn/signUp only after notifying its subscribers, so
  // the auth provider has already published the new session while the manual accept() is still awaiting its POST — the
  // effect below then sees a signed-in user and fires a second request with the same single-use token, and the loser
  // reports "already accepted" on an invitation that in fact just succeeded. Released on failure so a genuine retry
  // (signing in as the right account after a wrong-address 403) still works.
  const inFlight = useRef(false);
  const accept = useCallback(async () => {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: 'accepting' });
    setError(null);
    try {
      await api.post('/invitations/accept', { token });
      await qc.invalidateQueries({ queryKey: meQueryKey });
      setPhase({ kind: 'done' });
      navigate('/', { replace: true });
    } catch (e) {
      // The API distinguishes expired / already accepted / wrong email; surface its message rather than a generic one.
      setError(e instanceof ApiError ? e.message : t('auth.inviteFailed'));
      setPhase({ kind: 'form' });
      inFlight.current = false;
    }
  }, [token, qc, navigate, t]);

  // Already signed in (or just signed in): nothing left to collect, redeem straight away. Deferred off the effect body
  // so the first setState inside accept() is not synchronous; accept()'s own latch handles the race with onSubmit.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!session || !token || autoTried.current) return;
    autoTried.current = true;
    void Promise.resolve().then(accept);
  }, [session, token, accept]);

  if (!token) {
    return (
      <AuthLayout>
        <Card className="w-full max-w-sm">
          <CardHeader><CardTitle className="text-xl">{t('auth.inviteInvalidTitle')}</CardTitle><CardDescription>{t('auth.inviteInvalidHint')}</CardDescription></CardHeader>
        </Card>
      </AuthLayout>
    );
  }

  if (phase.kind === 'confirmEmail') {
    return (
      <AuthLayout>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl"><MailCheck className="size-5 text-brand-700" /> {t('auth.inviteConfirmTitle')}</CardTitle>
            <CardDescription>{t('auth.inviteConfirmHint', { email: phase.email })}</CardDescription>
          </CardHeader>
        </Card>
      </AuthLayout>
    );
  }

  const submit = async (values: Form) => {
    setError(null);
    if (mode === 'signIn') {
      const { error: err } = await supabase.auth.signInWithPassword({ email: values.email, password: values.password });
      if (err) { setError(t('auth.invalid')); return; }
      await accept();
      return;
    }
    // Send them back to *this* link after they confirm. Without emailRedirectTo Supabase uses the project's Site URL,
    // which drops a freshly confirmed invitee on the dashboard with no membership — the one screen that cannot help
    // them. The URL is allow-listed in Auth → URL Configuration.
    const { data, error: err } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: { emailRedirectTo: invitationUrl(token) },
    });
    if (err) { setError(err.message); return; }
    // No session means the project requires email confirmation before the account can be used. Say so plainly instead
    // of leaving the invitee on a form that will never succeed.
    if (!data.session) { setPhase({ kind: 'confirmEmail', email: values.email }); return; }
    await accept();
  };

  const busy = phase.kind === 'accepting' || form.formState.isSubmitting;

  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('auth.inviteTitle')}</CardTitle>
          <CardDescription>{mode === 'signUp' ? t('auth.inviteHintSignUp') : t('auth.inviteHintSignIn')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* handleSubmit is invoked from the event, not during render: the handler reads a ref (accept()'s latch),
              and a callback built during render that touches a ref trips react-hooks' refs-during-render rule. */}
          <form onSubmit={(e) => void form.handleSubmit(submit)(e)} className="space-y-4" noValidate>
            <FormField label={t('auth.email')} htmlFor="invite-email" error={form.formState.errors.email?.message}>
              <Input id="invite-email" type="email" autoComplete="email" dir="ltr" {...form.register('email')} aria-invalid={!!form.formState.errors.email} />
            </FormField>
            <FormField
              label={t('auth.password')}
              htmlFor="invite-password"
              error={form.formState.errors.password ? t(form.formState.errors.password.message === 'tooShort' ? 'auth.passwordTooShort' : 'auth.passwordRequired') : undefined}
              hint={mode === 'signUp' ? t('auth.passwordHint') : undefined}
            >
              <Input id="invite-password" type="password" autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'} dir="ltr" {...form.register('password')} aria-invalid={!!form.formState.errors.password} />
            </FormField>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" loading={busy}>{mode === 'signUp' ? t('auth.inviteCreateAccount') : t('auth.signIn')}</Button>
            <div className="text-center text-sm">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => { setMode(mode === 'signUp' ? 'signIn' : 'signUp'); setError(null); form.setValue('mode', mode === 'signUp' ? 'signIn' : 'signUp'); }}
              >
                {mode === 'signUp' ? t('auth.inviteHaveAccount') : t('auth.inviteNeedAccount')}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
