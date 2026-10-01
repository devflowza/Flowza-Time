import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { MailCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { RESET_PATH } from '@/lib/auth-callback';
import { AuthLayout } from './auth-layout';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input } from '@/components/ui';

const schema = z.object({ email: z.email('auth.emailInvalid') });

/**
 * Asks Supabase Auth to e-mail a reset link that opens /auth/reset on this origin (docs/go-live.md §5a lists it in the
 * project's redirect allow-list; anything else falls back to the bare Site URL). The answer is the same whether or not an
 * account exists — no user enumeration — except when the request itself could not be made (rate limit, no network).
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: '' } });
  const onSubmit = form.handleSubmit(async ({ email }) => {
    setError(null);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${RESET_PATH}` });
    if (err && (err.status === 429 || err.code === 'over_email_send_rate_limit' || err.code === 'over_request_rate_limit')) { setError(t('auth.resetRateLimited')); return; }
    if (err && (err.name === 'AuthRetryableFetchError' || err.status === 0)) { setError(t('auth.authUnreachable')); return; }
    setSent(email);
  });
  const emailError = form.formState.errors.email?.message;
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('auth.reset')}</CardTitle>
          {sent ? null : <CardDescription>{t('auth.forgotHint')}</CardDescription>}
        </CardHeader>
        <CardContent>
          {sent ? (
            <div role="status" className="space-y-2 text-sm">
              <p className="flex items-start gap-2"><MailCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> {t('auth.resetSent', { email: sent })}</p>
              <p className="text-muted-foreground">{t('auth.resetSentHint')}</p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <FormField label={t('auth.email')} htmlFor="email" error={emailError ? t(emailError) : undefined}>
                <Input id="email" type="email" dir="ltr" autoComplete="email" {...form.register('email')} aria-invalid={!!emailError} />
              </FormField>
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>{t('auth.reset')}</Button>
            </form>
          )}
          <div className="mt-4 text-center text-sm"><Link to="/auth/sign-in" className="text-primary hover:underline">{t('auth.signIn')}</Link></div>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
