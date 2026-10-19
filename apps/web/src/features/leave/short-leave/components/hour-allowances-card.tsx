import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Baby, Pencil, Plus, Trash2 } from 'lucide-react';
import type { z } from 'zod';
import { HOUR_ALLOWANCE_KINDS, HOUR_ALLOWANCE_POSITIONS, hourAllowanceInputSchema, type HourAllowanceDto, type HourAllowanceInput } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@/components/ui';
import { fmtDate, todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { blankToUndefined } from '@/features/organization/form-utils';
import { toastJobQueued } from '@/features/employees/job-toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useHourAllowanceMutations, useHourAllowances } from '../api';
import { SL_NS } from '../i18n';
import { fmtDuration } from '../model';

type FormValues = z.input<typeof hourAllowanceInputSchema>;
const nullIfBlank = (v: unknown): unknown => (v === '' || v === undefined ? null : v);

function AllowanceDialog({ employeeId, allowance, open, onOpenChange }: { employeeId: string; allowance: HourAllowanceDto | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation(SL_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const { create, update } = useHourAllowanceMutations(employeeId);
  const form = useForm<FormValues, unknown, HourAllowanceInput>({
    resolver: zodResolver(hourAllowanceInputSchema),
    defaultValues: allowance
      ? { kind: allowance.kind, minutesPerDay: allowance.minutesPerDay, position: allowance.position, validFrom: allowance.validFrom, validTo: allowance.validTo, reference: allowance.reference ?? undefined, notes: allowance.notes ?? undefined }
      : { kind: 'NURSING', minutesPerDay: 60, position: 'START', validFrom: todayIso(tz), validTo: null },
  });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const position = useWatch({ control, name: 'position' });
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      const res = allowance
        ? await update.mutateAsync({ id: allowance.id, input: { minutesPerDay: v.minutesPerDay, position: v.position, validFrom: v.validFrom, validTo: v.validTo ?? null, reference: v.reference ?? null, notes: v.notes ?? null } })
        : await create.mutateAsync(v);
      toast.success(allowance ? t('allowances.updated') : t('allowances.created'));
      // a past day changes: the recalculation is a queue job — point at the recalculations, never at a sync page
      if (res.recalculationJobId) toastJobQueued(res.recalculationJobId, navigate, t('allowances.recalcHint'), { to: '/attendance?tab=recalc' });
      onOpenChange(false);
    } catch (e) { toastMutationError(e, navigate); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>{allowance ? t('allowances.edit') : t('allowances.add')}</DialogTitle><DialogDescription>{t('allowances.hint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={t('allowances.fields.kind')} htmlFor="ha-kind" required>
              <Controller control={control} name="kind" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={!!allowance}><SelectTrigger id="ha-kind"><SelectValue /></SelectTrigger><SelectContent>{HOUR_ALLOWANCE_KINDS.map((k) => <SelectItem key={k} value={k}>{t(`allowances.kinds.${k}`)}</SelectItem>)}</SelectContent></Select>
              )} />
            </FormField>
            <FormField label={t('allowances.fields.minutesPerDay')} htmlFor="ha-minutes" required error={errors.minutesPerDay?.message}>
              <Input id="ha-minutes" type="number" inputMode="numeric" min={15} max={240} step={5} dir="ltr" className="w-28 tnum" {...register('minutesPerDay', { valueAsNumber: true })} aria-invalid={!!errors.minutesPerDay} />
            </FormField>
            <FormField label={t('allowances.fields.position')} htmlFor="ha-position" required hint={position ? t(`allowances.positionHints.${position}`) : undefined}>
              <Controller control={control} name="position" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="ha-position"><SelectValue /></SelectTrigger><SelectContent>{HOUR_ALLOWANCE_POSITIONS.map((p) => <SelectItem key={p} value={p}>{t(`allowances.positions.${p}`)}</SelectItem>)}</SelectContent></Select>
              )} />
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('allowances.fields.validFrom')} htmlFor="ha-from" required error={errors.validFrom?.message}>
              <Input id="ha-from" type="date" dir="ltr" className="tnum" {...register('validFrom')} aria-invalid={!!errors.validFrom} />
            </FormField>
            <FormField label={t('allowances.fields.validTo')} htmlFor="ha-to" optional hint={t('allowances.validToHint')} error={errors.validTo ? (errors.validTo.message?.includes('nursing') ? t('allowances.nursingNeedsEnd') : errors.validTo.message) : undefined}>
              <Input id="ha-to" type="date" dir="ltr" className="tnum" {...register('validTo', { setValueAs: nullIfBlank })} aria-invalid={!!errors.validTo} />
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('allowances.fields.reference')} htmlFor="ha-ref" optional><Input id="ha-ref" maxLength={120} {...register('reference', { setValueAs: blankToUndefined })} /></FormField>
            <FormField label={t('allowances.fields.notes')} htmlFor="ha-notes" optional><Input id="ha-notes" maxLength={500} {...register('notes', { setValueAs: blankToUndefined })} /></FormField>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{allowance ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reduced hours on the employee profile (Attendance tab): the nursing hour and reduced hours for persons with disabilities.
 * Read with leave.view, managed with leave.manage (a leave entitlement HR's leave administrators grant). Hidden without
 * leave.view.
 */
export function HourAllowancesCard({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation(SL_NS);
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const canView = can('leave.view');
  const canManage = can('leave.manage');
  const q = useHourAllowances(employeeId, canView);
  const { remove } = useHourAllowanceMutations(employeeId);
  const [dialog, setDialog] = useState<{ open: boolean; allowance: HourAllowanceDto | null }>({ open: false, allowance: null });
  const [deleting, setDeleting] = useState<HourAllowanceDto | null>(null);
  if (!canView) return null;
  return (
    <Card className="mt-4" data-testid="hour-allowances">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div><CardTitle className="text-base">{t('allowances.title')}</CardTitle><CardDescription>{t('allowances.hint')}</CardDescription></div>
        {canManage ? <Button size="sm" onClick={() => setDialog({ open: true, allowance: null })}><Plus /> {t('allowances.add')}</Button> : null}
      </CardHeader>
      <CardContent>
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.isLoading ? <Skeleton className="h-16 w-full" /> : !q.data?.length ? <EmptyState icon={Baby} title={t('allowances.empty')} className="py-6" /> : (
          <ul className="divide-y">
            {q.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{t(`allowances.kinds.${a.kind}`)}<Badge variant="secondary" className="font-normal tnum">{t('allowances.minutesValue', { value: fmtDuration(a.minutesPerDay) })}</Badge><Badge variant="outline" className="font-normal">{t(`allowances.positions.${a.position}`)}</Badge>{a.active ? <Badge variant="success" dot>{t('allowances.active')}</Badge> : null}</p>
                  <p className="text-xs text-muted-foreground tnum">{fmtDate(a.validFrom)} → {a.validTo ? fmtDate(a.validTo) : t('allowances.openEnded')}{a.reference ? ` · ${a.reference}` : ''}</p>
                </div>
                {canManage ? <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, allowance: a })} aria-label={tc('common.edit')}><Pencil /></Button><Button size="sm" variant="ghost" onClick={() => setDeleting(a)} aria-label={tc('common.delete')}><Trash2 /></Button></span> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <AllowanceDialog key={`${dialog.open}-${dialog.allowance?.id ?? 'new'}`} employeeId={employeeId} allowance={dialog.allowance} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('allowances.deleteTitle')} description={t('allowances.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: (r) => { toast.success(t('allowances.deleted')); if (r.recalculationJobId) toastJobQueued(r.recalculationJobId, navigate, t('allowances.recalcHint'), { to: '/attendance?tab=recalc' }); setDeleting(null); }, onError: (e) => toastMutationError(e, navigate) }); }} />
    </Card>
  );
}
