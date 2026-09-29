import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { CalendarPlus, Pencil } from 'lucide-react';
import { SUBSCRIPTION_STATUSES, type PlatformSubscriptionDto, type SubscriptionStatus } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ErrorState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { usePlans } from '@/features/platform/api';
import { useAdmMutations, useTenantSubscription } from '../api';

const statusVariant = (s: SubscriptionStatus): 'success' | 'info' | 'warning' | 'neutral' => (s === 'active' ? 'success' : s === 'trialing' ? 'info' : s === 'past_due' ? 'warning' : 'neutral');
/** ISO date-time → the `yyyy-MM-dd` a date input takes (UTC), and back to end-of-day UTC. */
const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const fromDateInput = (d: string) => (d ? new Date(`${d}T23:59:59.000Z`).toISOString() : null);

/** New trial end: `days` after the later of now and the current trial end. */
function extendedTrialEnd(current: string | null | undefined, days: number): string {
  const base = Math.max(Date.now(), current ? new Date(current).getTime() : 0);
  return new Date(base + days * 86_400_000).toISOString();
}

const formSchema = z.object({
  planKey: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  trialEndsAt: z.string(),
  currentPeriodEnd: z.string(),
  cancelAt: z.string(),
  reason: z.string().trim().min(3).max(500),
});
type Values = z.infer<typeof formSchema>;

function EditSubscriptionDialog({ orgId, sub, open, onOpenChange }: { orgId: string; sub: PlatformSubscriptionDto | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('adm');
  const { t: tp } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const plans = usePlans();
  const { updateSubscription } = useAdmMutations();
  const form = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: { planKey: sub?.planKey ?? '', status: sub?.status ?? 'active', trialEndsAt: toDateInput(sub?.trialEndsAt ?? null), currentPeriodEnd: toDateInput(sub?.currentPeriodEnd ?? null), cancelAt: toDateInput(sub?.cancelAt ?? null), reason: '' },
  });
  const { register, control, formState: { errors } } = form;
  const submit = form.handleSubmit((v) => {
    const input: Parameters<typeof updateSubscription.mutate>[0]['input'] = { reason: v.reason };
    if (v.planKey !== sub?.planKey) input.planKey = v.planKey;
    if (v.status !== sub?.status) input.status = v.status;
    if (v.trialEndsAt !== toDateInput(sub?.trialEndsAt ?? null)) input.trialEndsAt = fromDateInput(v.trialEndsAt);
    if (v.currentPeriodEnd !== toDateInput(sub?.currentPeriodEnd ?? null)) input.currentPeriodEnd = fromDateInput(v.currentPeriodEnd);
    if (v.cancelAt !== toDateInput(sub?.cancelAt ?? null)) input.cancelAt = fromDateInput(v.cancelAt);
    if (!sub && !input.planKey) input.planKey = v.planKey;
    updateSubscription.mutate({ id: orgId, input }, { onSuccess: () => { toast.success(t('subscription.saved')); onOpenChange(false); }, onError: toastError });
  });
  const date = (name: 'trialEndsAt' | 'currentPeriodEnd' | 'cancelAt', label: string) => (
    <FormField label={label} htmlFor={`sub-${name}`} hint={t('subscription.dateHint')}>
      <Input id={`sub-${name}`} type="date" dir="ltr" {...register(name)} />
    </FormField>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>{t('subscription.edit')}</DialogTitle><DialogDescription>{t('subscription.editHint')}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('subscription.plan')} htmlFor="sub-plan" required error={errors.planKey?.message}>
              <Controller control={control} name="planKey" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="sub-plan"><SelectValue /></SelectTrigger>
                  <SelectContent>{(plans.data ?? []).filter((p) => p.isActive || p.key === sub?.planKey).map((p) => <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label={t('subscription.status')} htmlFor="sub-status" required>
              <Controller control={control} name="status" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="sub-status"><SelectValue /></SelectTrigger>
                  <SelectContent>{SUBSCRIPTION_STATUSES.map((s) => <SelectItem key={s} value={s}>{tp(`subscription.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            {date('trialEndsAt', t('subscription.trialEnds'))}
            {date('currentPeriodEnd', t('subscription.periodEnd'))}
            {date('cancelAt', t('subscription.cancelAt'))}
          </div>
          <FormField label={t('subscription.reason')} htmlFor="sub-reason" required hint={t('subscription.reasonHint')} error={errors.reason?.message}>
            <Textarea id="sub-reason" rows={2} {...register('reason')} aria-invalid={!!errors.reason} />
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

/** Tenant → Subscription: plan, status, trial and billing period, with one-click trial extensions. */
export function SubscriptionPanel({ orgId, timezone }: { orgId: string; timezone: string }) {
  const { t } = useTranslation('adm');
  const { t: tp } = useTranslation('platform');
  const q = useTenantSubscription(orgId);
  const { updateSubscription } = useAdmMutations();
  const [editing, setEditing] = useState(false);
  const sub = q.data ?? null;
  const extend = (days: number) => {
    const trialEndsAt = extendedTrialEnd(sub?.trialEndsAt, days);
    updateSubscription.mutate(
      { id: orgId, input: { trialEndsAt, ...(sub?.status !== 'trialing' ? { status: 'trialing' as const } : {}), reason: t('subscription.extendReason', { count: days }) } },
      { onSuccess: (d) => toast.success(t('subscription.extended', { date: fmtDateTime(d.trialEndsAt, timezone, 'dd MMM yyyy') })), onError: toastError },
    );
  };
  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const row = (label: string, value: React.ReactNode) => <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 text-sm">{value}</dd></div>;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div><CardTitle>{t('subscription.title')}</CardTitle>{!sub ? <CardDescription>{t('subscription.noneHint')}</CardDescription> : null}</div>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil /> {t('subscription.edit')}</Button>
        </CardHeader>
        <CardContent>
          {!sub ? <p className="text-sm text-muted-foreground">{t('subscription.none')}</p> : (
            <dl className="grid gap-4 sm:grid-cols-2">
              {row(t('subscription.plan'), <span className="font-medium">{sub.planName} <span className="font-mono text-xs text-muted-foreground" dir="ltr">({sub.planKey})</span></span>)}
              {row(t('subscription.status'), <Badge variant={statusVariant(sub.status)}>{tp(`subscription.${sub.status}`)}</Badge>)}
              {row(t('subscription.trialEnds'), fmtDateTime(sub.trialEndsAt, timezone))}
              {row(t('subscription.periodStart'), fmtDateTime(sub.currentPeriodStart, timezone))}
              {row(t('subscription.periodEnd'), fmtDateTime(sub.currentPeriodEnd, timezone))}
              {row(t('subscription.cancelAt'), fmtDateTime(sub.cancelAt, timezone))}
            </dl>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><CalendarPlus className="size-4" aria-hidden /> {t('subscription.extendTrial')}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {[7, 14, 30].map((d) => <Button key={d} size="sm" variant="outline" disabled={!sub || updateSubscription.isPending} onClick={() => extend(d)}>{t('subscription.extendBy', { count: d })}</Button>)}
        </CardContent>
      </Card>
      {editing ? <EditSubscriptionDialog orgId={orgId} sub={sub} open onOpenChange={(v) => !v && setEditing(false)} /> : null}
    </div>
  );
}
