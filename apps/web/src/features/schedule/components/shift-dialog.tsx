import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { RECORD_STATUSES, SHIFT_TYPES, shiftInputSchema, type ShiftInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { blankToUndefined, toOptionalNumber } from '@/features/organization/form-utils';
import { useShiftMutations } from '../api';
import type { ShiftDto } from '../types';
import { BreaksEditor } from './breaks-editor';
import { dayBoundaryGuide, flexibleGuide, joinMinutes, SAMPLE_NIGHT, splitMinutes } from '../flexible-guide';

type FormValues = z.input<typeof shiftInputSchema>;
const COLORS = ['#0f6e56', '#175cd3', '#b54708', '#7a2e9d', '#b42318', '#0e7490', '#4d7c0f', '#475467'];

function toDefaults(s: ShiftDto | null): FormValues {
  if (!s) return { code: '', name: '', type: 'FIXED', startTime: '09:00', endTime: '17:00', dayBoundary: '04:00', breaks: [], punchInWindowBeforeMinutes: 240, punchOutWindowAfterMinutes: 360, graceInMinutes: null, graceOutMinutes: null, color: COLORS[0], status: 'active' };
  return {
    code: s.code, name: s.name, nameAr: s.nameAr ?? undefined, type: s.type as FormValues['type'], startTime: s.startTime ?? undefined, endTime: s.endTime ?? undefined, requiredMinutes: s.requiredMinutes ?? undefined, coreStart: s.coreStart ?? undefined, coreEnd: s.coreEnd ?? undefined,
    dayBoundary: s.dayBoundary, breaks: s.breaks ?? [], punchInWindowBeforeMinutes: s.punchInWindowBeforeMinutes, punchOutWindowAfterMinutes: s.punchOutWindowAfterMinutes, graceInMinutes: s.graceInMinutes, graceOutMinutes: s.graceOutMinutes, color: s.color ?? undefined, status: s.status as FormValues['status'],
  };
}

/** The required time of a flexible shift as hours + minutes (stored as `requiredMinutes`); both blank = not entered. */
function RequiredTimeInput({ value, onChange, invalid }: { value: unknown; onChange: (minutes: number | undefined) => void; invalid: boolean }) {
  const { t } = useTranslation('schedule');
  const [text, setText] = useState(() => splitMinutes(value));
  const set = (next: { hours: string; minutes: string }) => { setText(next); onChange(joinMinutes(next.hours, next.minutes)); };
  return (
    <div className="flex items-center gap-2">
      <Input id="sh-required" type="number" dir="ltr" min={0} max={24} inputMode="numeric" className="w-20 tnum" aria-label={t('shifts.requiredHours')} aria-invalid={invalid} value={text.hours} onChange={(e) => set({ ...text, hours: e.target.value })} />
      <span className="text-sm text-muted-foreground">{t('shifts.hoursUnit')}</span>
      <Input id="sh-required-min" type="number" dir="ltr" min={0} max={59} inputMode="numeric" className="w-20 tnum" aria-label={t('shifts.requiredMins')} aria-invalid={invalid} value={text.minutes} onChange={(e) => set({ ...text, minutes: e.target.value })} />
      <span className="text-sm text-muted-foreground">{t('shifts.minutesUnit')}</span>
    </div>
  );
}

/** Shift editor (shiftInputSchema): FIXED start/end vs FLEXIBLE required time + day boundary + opt-in core hours; breaks, punch windows, grace overrides, colour. */
export function ShiftDialog({ open, onOpenChange, shift }: { open: boolean; onOpenChange: (o: boolean) => void; shift: ShiftDto | null }) {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const { create, update } = useShiftMutations();
  const form = useForm<FormValues, unknown, ShiftInput>({ resolver: zodResolver(shiftInputSchema), defaultValues: toDefaults(shift) });
  const { register, control, setValue, setError, formState: { errors, isSubmitting } } = form;
  const type = useWatch({ control, name: 'type' }) ?? 'FIXED';
  const color = useWatch({ control, name: 'color' });
  // Core hours are opt-in: they only apply while switched on; switched off they are cleared on save (null), never left behind.
  const [coreOn, setCoreOn] = useState(() => !!(shift?.coreStart || shift?.coreEnd));
  const coreStart = useWatch({ control, name: 'coreStart' });
  const coreEnd = useWatch({ control, name: 'coreEnd' });
  const flex = flexibleGuide(useWatch({ control, name: 'requiredMinutes' }), coreOn ? coreStart : null, coreOn ? coreEnd : null, useWatch({ control, name: 'breaks' }));
  const boundary = dayBoundaryGuide(useWatch({ control, name: 'dayBoundary' }));
  const onSubmit = form.handleSubmit(async (values) => {
    if (type === 'FLEXIBLE' && coreOn && (!values.coreStart || !values.coreEnd)) {
      setError(values.coreStart ? 'coreEnd' : 'coreStart', { message: t('shifts.coreBothNeeded') });
      return;
    }
    try {
      const input: ShiftInput = type === 'FIXED'
        ? { ...values, requiredMinutes: undefined, coreStart: null, coreEnd: null }
        : { ...values, startTime: undefined, endTime: undefined, ...(coreOn ? {} : { coreStart: null, coreEnd: null }) };
      if (shift) { await update.mutateAsync({ id: shift.id, input }); toast.success(t('shifts.updated')); }
      else { await create.mutateAsync(input); toast.success(t('shifts.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{shift ? t('shifts.edit') : t('shifts.add')}</DialogTitle><DialogDescription>{t('shifts.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <section className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.code')} htmlFor="sh-code" required error={errors.code?.message}><Input id="sh-code" dir="ltr" className="font-mono" {...register('code')} aria-invalid={!!errors.code} disabled={!!shift} /></FormField>
            <FormField label={tc('common.name')} htmlFor="sh-name" required error={errors.name?.message}><Input id="sh-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={t('fields.nameAr')} htmlFor="sh-nameAr" optional error={errors.nameAr?.message}><Input id="sh-nameAr" dir="rtl" {...register('nameAr', { setValueAs: blankToUndefined })} /></FormField>
            <FormField label={t('shifts.type')} htmlFor="sh-type" required error={errors.type?.message} hint={t(`shifts.typeHint.${type}`)}>
              <Controller control={control} name="type" render={({ field }) => (
                <Select value={field.value ?? 'FIXED'} onValueChange={field.onChange}>
                  <SelectTrigger id="sh-type"><SelectValue /></SelectTrigger>
                  <SelectContent>{SHIFT_TYPES.map((s) => <SelectItem key={s} value={s}>{t(`shifts.types.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
          </section>

          <section className="space-y-3">
            <h4 className="text-sm font-semibold">{t('shifts.timing')}</h4>
            {type === 'FIXED' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label={t('shifts.startTime')} htmlFor="sh-start" required error={errors.startTime?.message}><Input id="sh-start" type="time" dir="ltr" className="tnum" {...register('startTime', { setValueAs: blankToUndefined })} aria-invalid={!!errors.startTime} /></FormField>
                <FormField label={t('shifts.endTime')} htmlFor="sh-end" required error={errors.endTime?.message} hint={t('shifts.endTimeHint')}><Input id="sh-end" type="time" dir="ltr" className="tnum" {...register('endTime', { setValueAs: blankToUndefined })} aria-invalid={!!errors.endTime} /></FormField>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label={t('shifts.requiredTime')} htmlFor="sh-required" required error={errors.requiredMinutes?.message} hint={flex.example ? `${t('shifts.requiredTimeHint')} ${t('shifts.checkOutExample', flex.example)}` : t('shifts.requiredTimeHint')}>
                    <Controller control={control} name="requiredMinutes" render={({ field }) => <RequiredTimeInput value={field.value} onChange={field.onChange} invalid={!!errors.requiredMinutes} />} />
                  </FormField>
                  <FormField label={t('shifts.dayBoundary')} htmlFor="sh-boundary" error={errors.dayBoundary?.message} hint={t('shifts.dayBoundaryHint')}><Input id="sh-boundary" type="time" dir="ltr" className="w-36 tnum" {...register('dayBoundary')} aria-invalid={!!errors.dayBoundary} /></FormField>
                </div>
                {boundary ? (
                  <div className={cn('space-y-1 rounded-md border px-3 py-2 text-xs', boundary.split ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200' : 'bg-muted/40 text-muted-foreground')} data-testid="boundary-guide" role={boundary.split ? 'status' : undefined}>
                    <p className="tnum">{t('shifts.boundaryRange', { boundary: boundary.boundary, last: boundary.last, lastDay: t(`shifts.sampleDays.${boundary.lastDay}`) })}</p>
                    <p className="tnum">{boundary.split
                      ? t('shifts.boundarySplit', { in: SAMPLE_NIGHT.in, out: SAMPLE_NIGHT.out, inDay: t(`shifts.sampleDays.${boundary.inDay}`), outDay: t(`shifts.sampleDays.${boundary.outDay}`) })
                      : t('shifts.boundaryTogether', { in: SAMPLE_NIGHT.in, out: SAMPLE_NIGHT.out, boundary: boundary.boundary })}</p>
                  </div>
                ) : null}

                <div className="space-y-3 rounded-md border p-3" data-testid="core-hours">
                  <label className="flex items-start gap-3">
                    <Switch className="mt-0.5" checked={coreOn} onCheckedChange={setCoreOn} aria-label={t('shifts.useCore')} />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">{t('shifts.useCore')}</span>
                      <span className="block text-xs text-muted-foreground">{coreOn ? t('shifts.coreHint') : t('shifts.coreOffHint')}</span>
                    </span>
                  </label>
                  {coreOn ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormField label={t('shifts.coreStart')} htmlFor="sh-cstart" required error={errors.coreStart?.message}><Input id="sh-cstart" type="time" dir="ltr" className="tnum" {...register('coreStart', { setValueAs: blankToUndefined })} aria-invalid={!!errors.coreStart} /></FormField>
                      <FormField label={t('shifts.coreEnd')} htmlFor="sh-cend" required error={errors.coreEnd?.message}><Input id="sh-cend" type="time" dir="ltr" className="tnum" {...register('coreEnd', { setValueAs: blankToUndefined })} aria-invalid={!!errors.coreEnd} /></FormField>
                    </div>
                  ) : null}
                  {coreOn && flex.coreTooLong ? <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" role="status">{t('shifts.coreLongerThanRequired', flex.coreTooLong)}</p> : null}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold">{t('shifts.breaks')}</h4>
            <Controller control={control} name="breaks" render={({ field }) => <BreaksEditor value={(field.value ?? []) as ShiftInput['breaks']} onChange={field.onChange} />} />
            {typeof errors.breaks?.message === 'string' ? <p className="text-xs text-destructive" role="alert">{errors.breaks.message}</p> : null}
          </section>

          <section className="space-y-3">
            <h4 className="text-sm font-semibold">{t('shifts.windows')}</h4>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <FormField label={t('shifts.punchInWindow')} htmlFor="sh-inwin" error={errors.punchInWindowBeforeMinutes?.message} hint={t('shifts.punchInWindowHint')}><Input id="sh-inwin" type="number" min={0} max={720} dir="ltr" className="tnum" {...register('punchInWindowBeforeMinutes', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.punchInWindowBeforeMinutes} /></FormField>
              <FormField label={t('shifts.punchOutWindow')} htmlFor="sh-outwin" error={errors.punchOutWindowAfterMinutes?.message} hint={t('shifts.punchOutWindowHint')}><Input id="sh-outwin" type="number" min={0} max={720} dir="ltr" className="tnum" {...register('punchOutWindowAfterMinutes', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.punchOutWindowAfterMinutes} /></FormField>
              <FormField label={t('shifts.graceIn')} htmlFor="sh-gin" optional error={errors.graceInMinutes?.message} hint={t('shifts.graceHint')}><Input id="sh-gin" type="number" min={0} max={240} dir="ltr" className="tnum" placeholder={t('shifts.inherit')} {...register('graceInMinutes', { setValueAs: (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v)) })} aria-invalid={!!errors.graceInMinutes} /></FormField>
              <FormField label={t('shifts.graceOut')} htmlFor="sh-gout" optional error={errors.graceOutMinutes?.message} hint={t('shifts.graceHint')}><Input id="sh-gout" type="number" min={0} max={240} dir="ltr" className="tnum" placeholder={t('shifts.inherit')} {...register('graceOutMinutes', { setValueAs: (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v)) })} aria-invalid={!!errors.graceOutMinutes} /></FormField>
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('shifts.color')} htmlFor="sh-color" optional error={errors.color?.message}>
              <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('shifts.color')}>
                {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={cn('size-7 rounded-full border-2 transition-transform focus-visible:ring-2 focus-visible:ring-ring', color === c ? 'scale-110 border-foreground' : 'border-transparent')} style={{ backgroundColor: c }} onClick={() => setValue('color', c, { shouldDirty: true })} />)}
                <Input id="sh-color" dir="ltr" className="h-8 w-28 font-mono text-xs" placeholder="#0f6e56" {...register('color', { setValueAs: blankToUndefined })} aria-invalid={!!errors.color} />
              </div>
            </FormField>
            {shift ? (
              <FormField label={tc('common.status')} htmlFor="sh-status">
                <Controller control={control} name="status" render={({ field }) => (
                  <Select value={field.value ?? 'active'} onValueChange={field.onChange}>
                    <SelectTrigger id="sh-status"><SelectValue /></SelectTrigger>
                    <SelectContent>{RECORD_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`recordStatus.${s}`)}</SelectItem>)}</SelectContent>
                  </Select>
                )} />
              </FormField>
            ) : null}
          </section>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{shift ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
