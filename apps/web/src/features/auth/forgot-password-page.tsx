import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabase';
import { AuthLayout } from './auth-layout';
import { Button, Card, CardContent, CardHeader, CardTitle, FormField, Input } from '@/components/ui';

const schema = z.object({ email: z.email() });

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [sent, setSent] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: '' } });
  const onSubmit = form.handleSubmit(async ({ email }) => {
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/reset` });
    setSent(email); // same message whether or not the account exists (no user enumeration)
  });
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader><CardTitle className="text-xl">{t('auth.reset')}</CardTitle></CardHeader>
        <CardContent>
          {sent ? <p className="text-sm">{t('auth.resetSent', { email: sent })}</p> : (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <FormField label={t('auth.email')} htmlFor="email" error={form.formState.errors.email?.message}>
                <Input id="email" type="email" dir="ltr" autoComplete="email" {...form.register('email')} />
              </FormField>
              <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>{t('auth.reset')}</Button>
            </form>
          )}
          <div className="mt-4 text-center text-sm"><Link to="/auth/sign-in" className="text-primary hover:underline">{t('auth.signIn')}</Link></div>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

const resetSchema = z.object({ password: z.string().min(12), confirm: z.string() }).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema), defaultValues: { password: '', confirm: '' } });
  const onSubmit = form.handleSubmit(async ({ password }) => {
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) { setError(err.message); return; }
    setDone(true);
  });
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader><CardTitle className="text-xl">{t('auth.newPassword')}</CardTitle></CardHeader>
        <CardContent>
          {done ? <Link to="/" className="text-primary hover:underline">{t('common.goHome')}</Link> : (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <FormField label={t('auth.newPassword')} htmlFor="password" error={form.formState.errors.password?.message}>
                <Input id="password" type="password" dir="ltr" autoComplete="new-password" {...form.register('password')} />
              </FormField>
              <FormField label={t('auth.confirmPassword')} htmlFor="confirm" error={form.formState.errors.confirm?.message}>
                <Input id="confirm" type="password" dir="ltr" autoComplete="new-password" {...form.register('confirm')} />
              </FormField>
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>{t('auth.update')}</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
