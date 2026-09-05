import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { KeyRound, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, FormField, Input, Skeleton } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { fmtDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { meQueryKey, useOrgTimezone } from '@/features/me/use-me';
import { CopyButton } from '@/features/audit/components/copy-button';

interface Enrolling { factorId: string; qr: string; secret: string; uri: string }

/** TOTP enrolment through Supabase Auth MFA (enroll → challenge → verify). Factors live in Supabase, not in our API. */
export function MfaEnrolment() {
  const { t } = useTranslation('settings');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const qc = useQueryClient();
  const factors = useQuery({ queryKey: ['mfa', 'factors'], queryFn: async () => { const { data, error } = await supabase.auth.mfa.listFactors(); if (error) throw error; return data; }, retry: false });
  const [enrolling, setEnrolling] = useState<Enrolling | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unenrolling, setUnenrolling] = useState<string | null>(null);
  const refresh = () => { void factors.refetch(); void qc.invalidateQueries({ queryKey: meQueryKey }); };

  const startEnrol = async () => {
    setBusy(true); setError(null);
    const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `FlowZa ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (err || !data) { setError(err?.message ?? t('security.mfa.error')); return; }
    setEnrolling({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri });
  };
  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enrolling) return;
    setBusy(true); setError(null);
    const ch = await supabase.auth.mfa.challenge({ factorId: enrolling.factorId });
    if (ch.error) { setError(ch.error.message); setBusy(false); return; }
    const res = await supabase.auth.mfa.verify({ factorId: enrolling.factorId, challengeId: ch.data.id, code });
    setBusy(false);
    if (res.error) { setError(res.error.message); return; }
    toast.success(t('security.mfa.enrolled'));
    setEnrolling(null); setCode(''); refresh();
  };
  const cancelEnrol = async () => { if (enrolling) await supabase.auth.mfa.unenroll({ factorId: enrolling.factorId }); setEnrolling(null); setCode(''); setError(null); };
  const unenroll = async () => {
    if (!unenrolling) return;
    setBusy(true);
    const { error: err } = await supabase.auth.mfa.unenroll({ factorId: unenrolling });
    setBusy(false); setUnenrolling(null);
    if (err) { toast.error(err.message); return; }
    toast.success(t('security.mfa.removed')); refresh();
  };

  const verified = (factors.data?.totp ?? []).filter((f) => f.status === 'verified');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-brand-700" /> {t('security.mfa.title')}</CardTitle>
        <CardDescription>{t('security.mfa.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {factors.isLoading ? <Skeleton className="h-16 w-full" /> : factors.isError ? <p role="alert" className="text-sm text-destructive">{t('security.mfa.listError')}</p> : verified.length === 0 && !enrolling ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-4">
            <div className="flex items-start gap-3"><Smartphone className="mt-0.5 size-5 text-muted-foreground" /><div><p className="text-sm font-medium">{t('security.mfa.none')}</p><p className="text-xs text-muted-foreground">{t('security.mfa.noneHint')}</p></div></div>
            <Button onClick={startEnrol} loading={busy}><KeyRound /> {t('security.mfa.enrol')}</Button>
          </div>
        ) : null}
        {verified.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {verified.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <div className="flex items-center gap-3"><Smartphone className="size-4 text-muted-foreground" /><div><p className="font-medium">{f.friendly_name || t('security.mfa.authenticator')}</p><p className="text-xs text-muted-foreground tnum">{t('security.mfa.addedAt', { at: fmtDateTime(f.created_at, tz) })}</p></div><Badge variant="success" dot>{t('security.mfa.active')}</Badge></div>
                <Button variant="ghost" size="icon" className="text-destructive" aria-label={t('security.mfa.remove')} onClick={() => setUnenrolling(f.id)}><Trash2 /></Button>
              </li>
            ))}
            {!enrolling ? <li className="p-3"><Button variant="outline" size="sm" onClick={startEnrol} loading={busy}><KeyRound /> {t('security.mfa.addAnother')}</Button></li> : null}
          </ul>
        ) : null}
        {enrolling ? (
          <form onSubmit={verify} className="grid gap-4 rounded-md border bg-accent/30 p-4 sm:grid-cols-[160px_1fr]">
            <img src={enrolling.qr} alt={t('security.mfa.qrAlt')} className="size-40 rounded-md bg-white p-2" />
            <div className="space-y-3">
              <p className="text-sm">{t('security.mfa.scan')}</p>
              <div className="flex items-center gap-2"><code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs" dir="ltr">{enrolling.secret}</code><CopyButton value={enrolling.secret} label={t('security.mfa.copySecret')} /></div>
              <FormField label={t('security.mfa.code')} htmlFor="mfa-code" error={error ?? undefined}>
                <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} className="tnum w-40 text-center text-lg tracking-widest" />
              </FormField>
              <div className="flex gap-2"><Button type="submit" loading={busy} disabled={code.length !== 6}>{t('security.mfa.verify')}</Button><Button type="button" variant="ghost" onClick={cancelEnrol}>{tc('common.cancel')}</Button></div>
            </div>
          </form>
        ) : null}
        {error && !enrolling ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
      <ConfirmDialog open={!!unenrolling} onOpenChange={(o) => !o && setUnenrolling(null)} title={t('security.mfa.removeTitle')} description={t('security.mfa.removeHint')} confirmLabel={t('security.mfa.remove')} destructive loading={busy} onConfirm={unenroll} />
    </Card>
  );
}
