import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabase';
import { useAuth } from './auth-provider';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input } from '@/components/ui';
import { AuthLayout } from './auth-layout';

const schema = z.object({ email: z.email(), password: z.string().min(1) });
type Form = z.infer<typeof schema>;

export function SignInPage() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState<{ factorId: string } | null>(null);
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (session && !mfa) return <Navigate to={from} replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword(values);
    if (err) { setError(t('auth.invalid')); return; }
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data && data.nextLevel === 'aal2' && data.nextLevel !== data.currentLevel) {
      const factors = await supabase.auth.mfa.listFactors();
      const totp = factors.data?.totp[0];
      if (totp) setMfa({ factorId: totp.id });
    }
  });

  if (mfa) return <MfaChallenge factorId={mfa.factorId} onDone={() => setMfa(null)} />;

  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('auth.signInTitle')}</CardTitle>
          <CardDescription>{t('app.tagline')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <FormField label={t('auth.email')} htmlFor="email" error={form.formState.errors.email?.message}>
              <Input id="email" type="email" autoComplete="email" dir="ltr" {...form.register('email')} aria-invalid={!!form.formState.errors.email} />
            </FormField>
            <FormField label={t('auth.password')} htmlFor="password" error={form.formState.errors.password?.message}>
              <Input id="password" type="password" autoComplete="current-password" dir="ltr" {...form.register('password')} aria-invalid={!!form.formState.errors.password} />
            </FormField>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>{t('auth.signIn')}</Button>
            <div className="text-center text-sm"><Link to="/auth/forgot" className="text-primary hover:underline">{t('auth.forgot')}</Link></div>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

function MfaChallenge({ factorId, onDone }: { factorId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error) { setError(challenge.error.message); setBusy(false); return; }
    const res = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code });
    setBusy(false);
    if (res.error) { setError(res.error.message); return; }
    onDone();
  };
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader><CardTitle className="text-xl">{t('auth.mfaTitle')}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={verify} className="space-y-4">
            <FormField label={t('auth.mfaCode')} htmlFor="code" error={error ?? undefined}>
              <Input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} className="tnum text-center text-lg tracking-widest" />
            </FormField>
            <Button type="submit" className="w-full" loading={busy}>{t('auth.verify')}</Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
