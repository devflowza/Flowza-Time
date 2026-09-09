import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { MailCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from './auth-provider';
import { AuthLayout } from './auth-layout';
import { browserTimezone, savePendingOrganization, useCreateOrganization } from './create-organization';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input } from '@/components/ui';

/**
 * Self-service account creation.
 *
 * Creates the identity in Supabase Auth, then the organisation through `POST /orgs` (the caller becomes its owner).
 * The second step needs a session; when the project requires email confirmation there is none yet, so the company
 * details are parked locally and the shell's create-organisation screen finishes the job after the first sign-in.
 *
 * Messages are keyed to what Supabase returns: `session: null` means the project requires email confirmation, so the
 * user is told to check their inbox instead of being left on a form that already succeeded.
 */
const schema = z
  .object({
    companyName: z.string().trim().min(2, 'companyTooShort').max(120, 'companyTooLong'),
    email: z.email('invalidEmail'),
    // 12 characters is the policy for CHOOSING a password (see the reset and invitation pages); the Supabase project
    // enforces the same minimum server-side, so a shorter one would fail there with a less helpful message.
    password: z.string().min(12, 'tooShort'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'mismatch' });
type Form = z.infer<typeof schema>;

const MESSAGE_KEYS: Record<string, string> = {
  companyTooShort: 'auth.companyNameTooShort',
  companyTooLong: 'auth.companyNameTooLong',
  invalidEmail: 'auth.emailInvalid',
  tooShort: 'auth.passwordTooShort',
  mismatch: 'auth.passwordMismatch',
};

export function SignUpPage() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);
  // Holds the redirect while the organisation is being created: the auth provider publishes the new session before
  // signUp even resolves, and leaving then would unmount this page mid-request.
  const [provisioning, setProvisioning] = useState(false);
  const createOrg = useCreateOrganization();
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { companyName: '', email: '', password: '', confirm: '' } });

  // Already signed in, or sign-up finished: nothing left to do here. The confirm-email screen wins because it never
  // has a session.
  if (session && !confirmEmail && !provisioning) return <Navigate to="/" replace />;

  const message = (code: string | undefined, fallback: string) => (code ? t(MESSAGE_KEYS[code] ?? fallback) : undefined);

  const onSubmit = form.handleSubmit(async ({ companyName, email, password }) => {
    setError(null);
    const organization = { displayName: companyName, timezone: browserTimezone() };
    // Parked before the account exists so nothing is lost whichever way Supabase answers.
    savePendingOrganization(organization);
    setProvisioning(true);
    try {
      const { data, error: err } = await supabase.auth.signUp({
        email,
        password,
        // After confirming, land on the app itself rather than the project's Site URL.
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (err) { setError(err.message); return; }
      if (!data.session) { setConfirmEmail(email); return; }
      // Failure here is not fatal: the shell's create-organisation screen picks the parked details up and shows the
      // API's reason on retry, which this page cannot do once the session redirect fires.
      await createOrg.mutateAsync(organization).catch(() => undefined);
    } finally {
      setProvisioning(false);
    }
  });

  if (confirmEmail) {
    return (
      <AuthLayout>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl"><MailCheck className="size-5 text-brand-700" /> {t('auth.signUpConfirmTitle')}</CardTitle>
            <CardDescription>{t('auth.signUpConfirmHint', { email: confirmEmail })}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center text-sm"><Link to="/auth/sign-in" className="text-primary hover:underline">{t('auth.signIn')}</Link></div>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  const errors = form.formState.errors;
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('auth.signUpTitle')}</CardTitle>
          <CardDescription>{t('auth.signUpHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <FormField label={t('auth.companyName')} htmlFor="signup-company" hint={t('auth.companyNameHint')} error={message(errors.companyName?.message, 'auth.companyNameTooShort')}>
              <Input id="signup-company" autoComplete="organization" {...form.register('companyName')} aria-invalid={!!errors.companyName} />
            </FormField>
            <FormField label={t('auth.email')} htmlFor="signup-email" error={message(errors.email?.message, 'auth.emailInvalid')}>
              <Input id="signup-email" type="email" autoComplete="email" dir="ltr" {...form.register('email')} aria-invalid={!!errors.email} />
            </FormField>
            <FormField label={t('auth.password')} htmlFor="signup-password" hint={t('auth.passwordHint')} error={message(errors.password?.message, 'auth.passwordTooShort')}>
              <Input id="signup-password" type="password" autoComplete="new-password" dir="ltr" {...form.register('password')} aria-invalid={!!errors.password} />
            </FormField>
            <FormField label={t('auth.confirmPassword')} htmlFor="signup-confirm" error={message(errors.confirm?.message, 'auth.passwordMismatch')}>
              <Input id="signup-confirm" type="password" autoComplete="new-password" dir="ltr" {...form.register('confirm')} aria-invalid={!!errors.confirm} />
            </FormField>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>{t('auth.createAccount')}</Button>
            <div className="text-center text-sm">
              {t('auth.haveAccount')} <Link to="/auth/sign-in" className="text-primary hover:underline">{t('auth.signIn')}</Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
