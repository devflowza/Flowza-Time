import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { INVITATION_STATES, type InvitationPreviewDto } from '@flowza/contracts';
import { supabase } from '@/lib/supabase';
import { api, ApiError, type Envelope } from '@/lib/api-client';
import { registerNamespace } from '@/lib/i18n-namespace';
import { meQueryKey } from '@/features/me/use-me';
import invitationEn from '@/locales/en/invitation.json';
import invitationAr from '@/locales/ar/invitation.json';
import { useAuth } from './auth-provider';
import { invitationUrl } from './invitation-url';
import { forgetPendingInvitation, rememberPendingInvitation } from './pending-invitation';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input } from '@/components/ui';
import { AuthLayout } from './auth-layout';

registerNamespace('invitation', invitationEn, invitationAr);

const STATE_TONE: Record<InvitationPreviewDto['state'], 'success' | 'neutral' | 'danger' | 'warning'> = { valid: 'success', accepted: 'neutral', revoked: 'danger', expired: 'warning' };
const isPreview = (v: unknown): v is InvitationPreviewDto => !!v && typeof v === 'object' && (INVITATION_STATES as readonly string[]).includes((v as { state?: string }).state ?? '');

/**
 * HR portal Prompt 6b (Finance B-70): what the link is — organisation, employee record, the invited address (masked), expiry
 * and its state — read from the public, rate-limited POST /invitations/validate BEFORE anybody signs in or creates an account.
 * Validation never accepts; a 404 means the token is unknown. Any other failure (rate limit, network) leaves the form usable:
 * the accept call decides anyway.
 */
function InvitationPreview({ preview }: { preview: InvitationPreviewDto }) {
  const { t } = useTranslation('invitation');
  const expires = new Date(preview.expiresAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  return (
    <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm" data-testid="invitation-preview">
      <p className="flex flex-wrap items-center justify-between gap-2 font-medium">{t('preview.title', { org: preview.organizationName })}<Badge variant={STATE_TONE[preview.state]}>{t(`preview.state.${preview.state}`)}</Badge></p>
      <p className="text-muted-foreground">{t('preview.for', { email: preview.emailMasked })}</p>
      {preview.employeeName ? <p className="text-muted-foreground">{t('preview.employee', { name: preview.employeeName })}</p> : null}
      {preview.state === 'valid' ? <p className="text-muted-foreground">{t('preview.expires', { date: expires })}</p> : null}
    </div>
  );
}

/**
 * Redeems an invitation token.
 *
 * `POST /invitations/accept` requires an authenticated caller — it binds the invitation to the caller's email — so an
 * invitee who has no account yet cannot use it directly. This page is the missing half: it authenticates first (sign
 * in, or sign up for someone who has never had an account) and then redeems the token, which is what makes a brand
 * new owner able to onboard at all.
 *
 * Self-service registration lives on /auth/sign-up (sign-up-page.tsx): a new user creates their own organisation and
 * becomes its owner. Joining an EXISTING organisation still happens only here, by redeeming an invitation.
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
  const { t: ti } = useTranslation('invitation');
  const [params] = useSearchParams();
  const token = params.get('token');
  const validation = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: async () => (await api.post<Envelope<InvitationPreviewDto>>('/invitations/validate', { token })).data,
    enabled: !!token, retry: false, staleTime: 60_000,
  });
  const preview = isPreview(validation.data) ? validation.data : null;
  const unknownToken = validation.error instanceof ApiError && validation.error.status === 404;
  // an accepted / withdrawn / expired invitation, or an unknown token, has nothing left to accept
  const closed = unknownToken || (!!preview && preview.state !== 'valid');
  const { session } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signUp');

  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '', mode: 'signUp' } });

  // The shell sends a signed-in invitee with no membership here while a token is remembered (pending-invitation.ts):
  // this page has now taken over, so forget it — whatever happens next is explained here, and nothing redirects twice.
  useEffect(() => { forgetPendingInvitation(); }, []);

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
  const checked = !validation.isLoading;
  useEffect(() => {
    // wait for the validation: a closed invitation is explained, not attempted
    if (!session || !token || autoTried.current || !checked || closed) return;
    autoTried.current = true;
    void Promise.resolve().then(accept);
  }, [session, token, accept, checked, closed]);

  if (!token) {
    return (
      <AuthLayout>
        <Card className="w-full max-w-sm">
          <CardHeader><CardTitle className="text-xl">{t('auth.inviteInvalidTitle')}</CardTitle><CardDescription>{t('auth.inviteInvalidHint')}</CardDescription></CardHeader>
        </Card>
      </AuthLayout>
    );
  }

  if (unknownToken) {
    return (
      <AuthLayout>
        <Card className="w-full max-w-sm">
          <CardHeader><CardTitle className="text-xl">{ti('preview.invalidTitle')}</CardTitle><CardDescription>{ti('preview.invalidHint')}</CardDescription></CardHeader>
        </Card>
      </AuthLayout>
    );
  }

  if (preview && preview.state !== 'valid' && phase.kind !== 'done') {
    return (
      <AuthLayout>
        <Card className="w-full max-w-sm">
          <CardHeader><CardTitle className="text-xl">{t('auth.inviteTitle')}</CardTitle><CardDescription>{ti(`preview.${preview.state}Hint`, { org: preview.organizationName })}</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <InvitationPreview preview={preview} />
            {preview.state === 'accepted' ? <Button asChild className="w-full"><Link to="/auth/sign-in">{ti('preview.signIn')}</Link></Button> : null}
          </CardContent>
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
          <CardContent>
            <Button asChild className="w-full"><Link to="/auth/sign-in">{t('auth.signIn')}</Link></Button>
          </CardContent>
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
    // Remember the invitation, so the invitee joins it however they come back once confirmed — the confirmation link, or
    // signing in — rather than landing on "create your organisation".
    if (!data.session) { rememberPendingInvitation(token); setPhase({ kind: 'confirmEmail', email: values.email }); return; }
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
        <CardContent className="space-y-4">
          {preview ? <InvitationPreview preview={preview} /> : validation.isLoading ? <p className="text-sm text-muted-foreground" aria-live="polite">{ti('preview.checking')}</p> : null}
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
