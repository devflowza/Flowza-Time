import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { toast } from '@/lib/toast';
import { useMe } from '@/features/me/use-me';
import { usePlatformAdmins } from '../api';
import { useTemporaryPassword } from '../use-temporary-password';

/** Mirrors the project password policy (supabase/config.toml: ≥ 12 characters, lower + upper + digit + symbol). */
const strong = (p: string) => p.length >= 12 && /\p{Ll}/u.test(p) && /\p{Lu}/u.test(p) && /\p{Nd}/u.test(p) && /[^\p{L}\p{Nd}]/u.test(p);

export default function AdmAccountPage() {
  const { t } = useTranslation('adm');
  const { data: me } = useMe();
  const admins = usePlatformAdmins();
  const self = admins.data?.find((a) => a.isSelf);
  const temporary = useTemporaryPassword();
  const [error, setError] = useState<string | null>(null);
  const schema = z.object({ password: z.string().refine(strong, t('account.tooWeak')), confirm: z.string() }).refine((v) => v.password === v.confirm, { path: ['confirm'], message: t('account.mismatch') });
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { password: '', confirm: '' } });
  const submit = form.handleSubmit(async ({ password }) => {
    setError(null);
    // clearing the flag in the same call ends the "temporary password" banner
    const { error: err } = await supabase.auth.updateUser({ password, data: { password_is_temporary: false } });
    if (err) { setError(err.message); return; }
    form.reset();
    toast.success(t('account.changed'));
  });
  return (
    <div className="page-container max-w-3xl space-y-4">
      <PageHeader title={t('account.title')} description={t('account.subtitle')} />
      <Card>
        <CardHeader><CardTitle>{t('account.profile')}</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('account.email')}</dt><dd className="truncate text-sm" dir="ltr">{me?.user.email}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('account.level')}</dt><dd className="text-sm">{self ? <Badge variant="warning">{t(`levels.${self.level}`)}</Badge> : '—'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('account.mfa')}</dt><dd className="flex items-center gap-1.5 text-sm">{me?.user.mfaEnrolled ? <><ShieldCheck className="size-4 text-emerald-600" aria-hidden /> {t('account.mfaOn')}</> : <><ShieldAlert className="size-4 text-red-600" aria-hidden /> {t('account.mfaOff')}</>}</dd></div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('account.password')}</CardTitle><CardDescription>{t('account.passwordHint')}</CardDescription></CardHeader>
        <CardContent>
          {temporary ? <p role="status" className="mb-4 flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"><TriangleAlert className="size-4 shrink-0" aria-hidden /> {t('account.tempHint')}</p> : null}
          <form onSubmit={submit} className="grid max-w-md gap-4" noValidate>
            <FormField label={t('account.newPassword')} htmlFor="new-password" error={form.formState.errors.password?.message}>
              <Input id="new-password" type="password" dir="ltr" autoComplete="new-password" {...form.register('password')} aria-invalid={!!form.formState.errors.password} />
            </FormField>
            <FormField label={t('account.confirm')} htmlFor="confirm-password" error={form.formState.errors.confirm?.message}>
              <Input id="confirm-password" type="password" dir="ltr" autoComplete="new-password" {...form.register('confirm')} aria-invalid={!!form.formState.errors.confirm} />
            </FormField>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <div><Button type="submit" loading={form.formState.isSubmitting}>{t('account.password')}</Button></div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
