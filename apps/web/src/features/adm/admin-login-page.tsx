import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import type { MeDto } from '@flowza/contracts';
import { supabase } from '@/lib/supabase';
import { api, isMfaRequiredError, isNetworkError, type Envelope } from '@/lib/api-client';
import { useAuth } from '@/features/auth/auth-provider';
import { clearPasswordRecovery } from '@/features/auth/password-recovery';
import { Button, FormField, Input } from '@/components/ui';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { AdmBrand } from './components/adm-brand';

const schema = z.object({ email: z.email(), password: z.string().min(1) });
type Form = z.infer<typeof schema>;

/**
 * `/adm/login` — the platform administrators' sign-in (Flowza Finance /adm parity). Password first, then the portal gate
 * takes over: a platform admin's session is refused below `aal2` by the API, so `/me` answering `MFA_REQUIRED` is itself
 * the proof that the account is an administrator and the gate shows MFA enrolment / verification. An account that is
 * not an administrator is signed out again here, before it ever sees the portal.
 */
export default function AdminLoginPage() {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const { session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [show, setShow] = useState(false);
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });
  const from = (location.state as { from?: string } | null)?.from;
  const target = from && from.startsWith('/adm') && !from.startsWith('/adm/login') ? from : '/adm';

  if (session && !checking) return <Navigate to={target} replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setChecking(true);
    const { error: err } = await supabase.auth.signInWithPassword(values);
    if (err) { setChecking(false); setError(t('login.invalid')); return; }
    clearPasswordRecovery(); // signed in with a password: an earlier reset link no longer holds the account on /auth/reset
    try {
      const me = (await api.get<Envelope<MeDto>>('/me')).data;
      if (!me.user.isPlatformAdmin) {
        await supabase.auth.signOut();
        setChecking(false);
        setError(t('login.notAdmin'));
        return;
      }
    } catch (e) {
      // only platform administrators are refused /me below aal2 — the gate asks for the second factor
      if (!isMfaRequiredError(e)) {
        await supabase.auth.signOut();
        setChecking(false);
        setError(isNetworkError(e) ? t('login.unreachable') : t('login.notAdmin'));
        return;
      }
    }
    setChecking(false);
    void navigate(target, { replace: true });
  });

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-slate-950 p-12 text-slate-300 lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-20">
          <div className="absolute -start-16 top-16 size-72 rounded-full bg-amber-500 blur-3xl" />
          <div className="absolute -end-10 bottom-10 size-96 rounded-full bg-emerald-600 blur-3xl" />
        </div>
        <AdmBrand className="relative" />
        <div className="relative max-w-md space-y-4">
          <h2 className="text-3xl font-semibold leading-tight text-white">{t('login.heroTitle')}</h2>
          <p className="text-sm text-slate-400">{t('login.heroBody')}</p>
          <p className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300"><ShieldCheck className="size-3.5" aria-hidden /> {t('login.secure')}</p>
        </div>
        <p className="relative text-xs text-slate-500">© F &amp; Z Capital</p>
      </div>
      <div className="flex flex-col">
        <div className="flex items-center justify-between p-4">
          <AdmBrand className="lg:invisible" tone="light" />
          <LanguageSwitcher />
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-sm space-y-6">
            <div className="space-y-1.5">
              <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400"><Lock className="size-5" aria-hidden /></div>
              <h1 className="text-2xl font-semibold tracking-tight">{t('login.title')}</h1>
              <p className="text-sm text-muted-foreground">{t('login.subtitle')}</p>
            </div>
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <FormField label={tc('auth.email')} htmlFor="adm-email" error={form.formState.errors.email?.message}>
                <Input id="adm-email" type="email" autoComplete="username" dir="ltr" autoFocus {...form.register('email')} aria-invalid={!!form.formState.errors.email} />
              </FormField>
              <FormField label={tc('auth.password')} htmlFor="adm-password" error={form.formState.errors.password?.message}>
                <div className="relative">
                  <Input id="adm-password" type={show ? 'text' : 'password'} autoComplete="current-password" dir="ltr" className="pe-10" {...form.register('password')} aria-invalid={!!form.formState.errors.password} />
                  <button type="button" onClick={() => setShow((s) => !s)} className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground" aria-label={show ? t('login.hidePassword') : t('login.showPassword')}>
                    {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </FormField>
              {error ? <p role="alert" className="rounded-md border border-red-300/60 bg-red-50 px-3 py-2 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-200">{error}</p> : null}
              <Button type="submit" className="w-full" loading={checking || form.formState.isSubmitting}>{t('login.submit')}</Button>
            </form>
            <div className="flex flex-col gap-2 text-center text-sm">
              <Link to="/auth/forgot" className="text-primary hover:underline">{tc('auth.forgot')}</Link>
              <Link to="/auth/sign-in" className="text-muted-foreground hover:underline">{t('login.tenantLogin')}</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
