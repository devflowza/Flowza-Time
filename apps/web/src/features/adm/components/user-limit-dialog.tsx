import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { toUserLimit, type UserLimitDto } from '@flowza/contracts';
import { Pencil, UsersRound } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Textarea } from '@/components/ui';
import { UserLimitMeter } from '@/components/user-limit-meter';
import { fmtNumber } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useAdmMutations } from '../api';

const STEPS = [1, 5, 10] as const;
const formSchema = z.object({
  limit: z.string().trim().regex(/^[1-9]\d{0,4}$|^100000$/),
  reason: z.string().trim().min(3).max(500),
});
type Values = z.infer<typeof formSchema>;

/**
 * Tenant → user limit: how many licensed users (active employees) the tenant may have. Only a platform admin changes it
 * (the subscription's seats); the tenant sees "used / limit" and "Maximum users reached" once it is full.
 */
export function UserLimitDialog({ orgId, orgName, value, open, onOpenChange }: { orgId: string; orgName: string; value: UserLimitDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const { updateSubscription } = useAdmMutations();
  const form = useForm<Values>({ resolver: zodResolver(formSchema), defaultValues: { limit: value.limit !== null ? String(value.limit) : '', reason: '' } });
  const { register, control, formState: { errors } } = form;
  const typed = Number(useWatch({ control, name: 'limit' }));
  const next = Number.isInteger(typed) && typed >= 1 && typed <= 100_000 ? typed : null;
  const preview = next !== null ? toUserLimit(value.used, next, 'seats') : null;
  const bump = (by: number) => {
    const base = Number(form.getValues('limit')) || value.limit || value.used;
    form.setValue('limit', String(Math.min(100_000, Math.max(1, base + by))), { shouldValidate: true, shouldDirty: true });
  };
  const submit = form.handleSubmit((v) => {
    const limit = Number(v.limit);
    updateSubscription.mutate({ id: orgId, input: { seats: limit, reason: v.reason } }, {
      onSuccess: () => { toast.success(t('userLimit.saved', { name: orgName, limit: fmtNumber(limit) })); onOpenChange(false); },
      onError: toastError,
    });
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>{t('userLimit.dialogTitle')}</DialogTitle><DialogDescription>{t('userLimit.dialogHint', { name: orgName })}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="rounded-md border p-3">
            <p className="mb-1 text-xs text-muted-foreground">{t('userLimit.current')}</p>
            <UserLimitMeter value={value} />
            {value.source === 'override' ? <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">{t('userLimit.overrideNote')}</p> : null}
            {value.source === 'plan' ? <p className="mt-2 text-xs text-muted-foreground">{t('userLimit.planNote')}</p> : null}
          </div>
          <FormField label={t('userLimit.limit')} htmlFor="user-limit" required hint={t('userLimit.limitHint')} error={errors.limit ? t('userLimit.limitInvalid') : undefined}>
            <div className="flex flex-wrap items-center gap-2">
              <Input id="user-limit" inputMode="numeric" dir="ltr" className="w-32" {...register('limit')} aria-invalid={!!errors.limit} />
              {STEPS.map((s) => <Button key={s} type="button" size="sm" variant="outline" onClick={() => bump(s)} aria-label={t('userLimit.increaseBy', { n: s })}>+{s}</Button>)}
            </div>
          </FormField>
          {preview ? (
            <div className="rounded-md border border-dashed p-3" data-testid="user-limit-preview">
              <p className="mb-1 text-xs text-muted-foreground">{t('userLimit.after')}</p>
              <UserLimitMeter value={preview} />
              {next !== null && next < value.used ? <p role="alert" className="mt-2 text-xs text-destructive">{t('userLimit.belowUsage', { used: fmtNumber(value.used) })}</p> : null}
            </div>
          ) : null}
          <FormField label={t('subscription.reason')} htmlFor="user-limit-reason" required hint={t('subscription.reasonHint')} error={errors.reason?.message}>
            <Textarea id="user-limit-reason" rows={2} {...register('reason')} aria-invalid={!!errors.reason} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={updateSubscription.isPending}>{tc('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Tenant overview: the tenant's users against its user limit, and the platform's one way to change it. */
export function UserLimitCard({ orgId, orgName, value, hasSubscription }: { orgId: string; orgName: string; value: UserLimitDto | undefined; hasSubscription: boolean }) {
  const { t } = useTranslation('adm');
  const [editing, setEditing] = useState(false);
  return (
    <Card data-testid="tenant-user-limit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><UsersRound className="size-4" aria-hidden /> {t('userLimit.title')}</CardTitle>
        <CardDescription>{t('userLimit.cardHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {value ? <UserLimitMeter value={value} /> : <p className="text-sm text-muted-foreground">—</p>}
        {!hasSubscription ? <p className="text-xs text-muted-foreground">{t('userLimit.noSubscription')}</p> : null}
        <Button size="sm" variant="outline" className="w-full" disabled={!value || !hasSubscription} onClick={() => setEditing(true)}><Pencil /> {t('userLimit.set')}</Button>
      </CardContent>
      {editing && value ? <UserLimitDialog orgId={orgId} orgName={orgName} value={value} open onOpenChange={(o) => !o && setEditing(false)} /> : null}
    </Card>
  );
}
