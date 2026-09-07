import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input, Skeleton } from '@/components/ui';
import { CopyButton } from '@/features/audit/components/copy-button';
import { AuthLayout } from './auth-layout';

/**
 * Blocking two-factor screen for a session the API refuses at `aal1`.
 *
 * `GET /me` is deliberately outside the per-organisation MFA gate so the UI can prompt for enrolment, but platform
 * administrators are gated globally in `requireAuth` — for them the very first request fails and the shell never
 * renders, so Settings → Security is unreachable. This screen is the way out: enrolment and verification talk to
 * Supabase Auth directly and need no API call, and once the session carries `aal2` the shell retries `/me`.
 */
type Mode =
  | { kind: 'loading' }
  | { kind: 'enrol' }
  | { kind: 'enrolling'; factorId: string; qr: string; secret: string }
  | { kind: 'challenge'; factorId: string }
  | { kind: 'unavailable' };

export function MfaRequiredGate({ onVerified }: { onVerified: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // An already verified factor only needs a challenge to step the session up; otherwise the user must enrol one.
  useEffect(() => {
    let active = true;
    void supabase.auth.mfa.listFactors().then(({ data, error: err }) => {
      if (!active) return;
      if (err || !data) { setMode({ kind: 'unavailable' }); setError(t('auth.mfaLoadError')); return; }
      const verified = data.totp.find((f) => f.status === 'verified');
      setMode(verified ? { kind: 'challenge', factorId: verified.id } : { kind: 'enrol' });
    });
    return () => { active = false; };
  }, [t]);

  const startEnrol = useCallback(async () => {
    setBusy(true); setError(null);
    const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `FlowZa ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (err || !data) { setError(err?.message ?? t('auth.mfaEnrolError')); return; }
    setMode({ kind: 'enrolling', factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }, [t]);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode.kind !== 'enrolling' && mode.kind !== 'challenge') return;
    const { factorId } = mode;
    setBusy(true); setError(null);
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error) { setError(challenge.error.message); setBusy(false); return; }
    const res = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code });
    setBusy(false);
    if (res.error) { setError(res.error.message); return; }
    setCode('');
    onVerified();
  }, [code, mode, onVerified]);

  const codeField = (
    <>
      <FormField label={t('auth.mfaCode')} htmlFor="mfa-code" error={error ?? undefined}>
        <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} className="tnum text-center text-lg tracking-widest" />
      </FormField>
      <Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>{t('auth.verify')}</Button>
    </>
  );

  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl"><ShieldCheck className="size-5 text-brand-700" /> {t('auth.mfaRequiredTitle')}</CardTitle>
          <CardDescription>{mode.kind === 'challenge' ? t('auth.mfaRequiredChallengeHint') : t('auth.mfaRequiredHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {mode.kind === 'loading' ? <Skeleton className="h-24 w-full" /> : null}

          {mode.kind === 'enrol' ? (
            <Button className="w-full" onClick={() => void startEnrol()} loading={busy}><KeyRound /> {t('auth.mfaEnrol')}</Button>
          ) : null}

          {mode.kind === 'enrolling' ? (
            <form onSubmit={submit} className="space-y-3">
              <img src={mode.qr} alt={t('auth.mfaQrAlt')} className="mx-auto size-40 rounded-md bg-white p-2" />
              <p className="text-sm">{t('auth.mfaScan')}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs" dir="ltr">{mode.secret}</code>
                <CopyButton value={mode.secret} label={t('auth.mfaCopySecret')} />
              </div>
              {codeField}
            </form>
          ) : null}

          {mode.kind === 'challenge' ? <form onSubmit={submit} className="space-y-3">{codeField}</form> : null}

          {mode.kind === 'unavailable' && error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {mode.kind === 'enrol' && error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

          <Button variant="ghost" className="w-full" onClick={() => void supabase.auth.signOut()}>{t('nav.signOut')}</Button>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
