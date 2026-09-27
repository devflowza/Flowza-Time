import { useMemo } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarCheck } from 'lucide-react';
import type { z } from 'zod';
import { HALF_DAY_PARTS, selfLeaveRequestSchema, type SelfLeaveDto, type SelfLeaveRequestInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from '@/components/ui';
import { todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useSelfLeaveMutations } from '../api';
import { fmtDays, previewLeaveDays } from '../model';
import { TypeDot } from './parts';

type FormValues = z.input<typeof selfLeaveRequestSchema>;

/**
 * Apply for leave (selfLeaveRequestSchema — the schema the API validates). The request starts PENDING; the preview
 * counts the working days it will charge with the employee's weekly offs and holidays, and warns (never blocks) when
 * it goes past the remaining allowance: HR decides.
 */
export function ApplyLeaveDialog({ open, onOpenChange, data }: { open: boolean; onOpenChange: (o: boolean) => void; data: SelfLeaveDto | undefined }) {
  const { t } = useTranslation('portal');
  const { t: tl } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const { apply } = useSelfLeaveMutations();
  const today = todayIso(tz);
  const form = useForm<FormValues, unknown, SelfLeaveRequestInput>({ resolver: zodResolver(selfLeaveRequestSchema), defaultValues: { leaveTypeId: '', startDate: today, endDate: today, isHalfDay: false, reason: '' } });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const [leaveTypeId, startDate, endDate, isHalfDay] = useWatch({ control, name: ['leaveTypeId', 'startDate', 'endDate', 'isHalfDay'] });

  const calendar = useMemo(() => ({ weeklyOffDays: data?.calendar.weeklyOffDays ?? [], holidays: new Set(data?.calendar.holidays ?? []) }), [data]);
  const days = startDate && endDate ? previewLeaveDays(startDate, endDate, !!isHalfDay, calendar) : 0;
  const type = data?.types.find((x) => x.id === leaveTypeId);
  const balance = data?.balances.find((b) => b.leaveTypeId === leaveTypeId);
  // requests in the viewed year are already in `remainingDays`; this one comes on top
  const remainingAfter = balance?.remainingDays !== null && balance?.remainingDays !== undefined ? balance.remainingDays - days : null;

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await apply.mutateAsync({ ...v, halfDayPart: v.isHalfDay ? v.halfDayPart ?? 'FIRST_HALF' : undefined });
      toast.success(t('apply.submitted'));
      onOpenChange(false);
    } catch (e) { toastMutationError(e, navigate); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('apply.title')}</DialogTitle><DialogDescription>{t('apply.hint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField label={t('apply.type')} htmlFor="al-type" required error={errors.leaveTypeId?.message}>
            <Controller control={control} name="leaveTypeId" render={({ field }) => (
              <Select value={field.value || undefined} onValueChange={field.onChange}>
                <SelectTrigger id="al-type" aria-invalid={!!errors.leaveTypeId}><SelectValue placeholder={t('apply.selectType')} /></SelectTrigger>
                <SelectContent>
                  {(data?.types ?? []).map((lt) => {
                    const b = data?.balances.find((x) => x.leaveTypeId === lt.id);
                    return (
                      <SelectItem key={lt.id} value={lt.id}>
                        <span className="flex items-center gap-2"><TypeDot color={lt.color} />{lt.name}{!lt.isPaid ? <span className="text-xs text-muted-foreground">· {t('leave.unpaid')}</span> : null}{b?.remainingDays !== null && b?.remainingDays !== undefined ? <span className="text-xs text-muted-foreground tnum">· {t('leave.remainingOf', { remaining: fmtDays(b.remainingDays), allowance: fmtDays(b.allowanceDays ?? 0) })}</span> : null}</span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('apply.start')} htmlFor="al-start" required error={errors.startDate?.message}>
              <Input id="al-start" type="date" dir="ltr" {...register('startDate', { onChange: (e) => { const v = (e.target as HTMLInputElement).value; if (isHalfDay || (endDate && v > endDate)) setValue('endDate', v); } })} aria-invalid={!!errors.startDate} />
            </FormField>
            <FormField label={t('apply.end')} htmlFor="al-end" required error={errors.endDate?.message}>
              <Input id="al-end" type="date" dir="ltr" min={startDate} disabled={!!isHalfDay} {...register('endDate')} aria-invalid={!!errors.endDate} />
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller control={control} name="isHalfDay" render={({ field }) => (
              <div className="flex items-center justify-between gap-4 rounded-md border p-3"><div><Label htmlFor="al-half">{t('apply.halfDay')}</Label><p className="text-xs text-muted-foreground">{t('apply.halfDayHint')}</p></div><Switch id="al-half" checked={!!field.value} onCheckedChange={(on) => { field.onChange(on); if (on) { setValue('endDate', form.getValues('startDate')); setValue('halfDayPart', 'FIRST_HALF'); } else setValue('halfDayPart', undefined); }} /></div>
            )} />
            {isHalfDay ? (
              <FormField label={t('apply.part')} htmlFor="al-part" error={errors.halfDayPart?.message}>
                <Controller control={control} name="halfDayPart" render={({ field }) => (
                  <Select value={field.value ?? 'FIRST_HALF'} onValueChange={field.onChange}><SelectTrigger id="al-part"><SelectValue /></SelectTrigger><SelectContent>{HALF_DAY_PARTS.map((p) => <SelectItem key={p} value={p}>{tl(`halfDayParts.${p}`)}</SelectItem>)}</SelectContent></Select>
                )} />
              </FormField>
            ) : null}
          </div>
          <FormField label={t('apply.reason')} htmlFor="al-reason" required hint={t('apply.reasonHint')} error={errors.reason?.message}>
            <Textarea id="al-reason" rows={3} maxLength={1000} {...register('reason')} aria-invalid={!!errors.reason} />
          </FormField>

          {startDate && endDate && endDate >= startDate ? (
            <div className={cn('flex gap-2.5 rounded-md border p-3 text-sm', days === 0 || (remainingAfter !== null && remainingAfter < 0) ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100' : 'bg-muted/40')} data-testid="leave-preview" aria-live="polite">
              {days === 0 || (remainingAfter !== null && remainingAfter < 0) ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CalendarCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
              <div className="space-y-0.5">
                <p>{days === 0 ? t('apply.previewNone') : t('apply.preview', { count: days, days: fmtDays(days) })}</p>
                {type && remainingAfter !== null && days > 0 ? <p className="text-xs">{remainingAfter < 0 ? t('apply.overBalance', { type: type.name, remaining: fmtDays(balance?.remainingDays ?? 0) }) : t('apply.balanceAfter', { type: type.name, remaining: fmtDays(remainingAfter) })}</p> : null}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting} disabled={days === 0}>{t('apply.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
