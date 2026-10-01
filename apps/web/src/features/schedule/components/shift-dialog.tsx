import { useRef, useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch, type UseFormGetValues, type UseFormSetValue } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { DEFAULT_ATTENDANCE_RULES, DEFAULT_PUNCH_IN_WINDOW_MINUTES, DEFAULT_PUNCH_OUT_WINDOW_MINUTES, DEFAULT_SHIFT_DAY_BOUNDARY, RECORD_STATUSES, SHIFT_TYPES, shiftInputSchema, type ShiftInput } from '@flowza/contracts';
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
  if (!s) return { code: '', name: '', type: 'FIXED', startTime: '09:00', endTime: '17:00', dayBoundary: DEFAULT_SHIFT_DAY_BOUNDARY, breaks: [], punchInWindowBeforeMinutes: DEFAULT_PUNCH_IN_WINDOW_MINUTES, punchOutWindowAfterMinutes: DEFAULT_PUNCH_OUT_WINDOW_MINUTES, graceInMinutes: null, graceOutMinutes: null, color: COLORS[0], status: 'active' };
  return {
    code: s.code, name: s.name, nameAr: s.nameAr ?? undefined, type: s.type as FormValues['type'], startTime: s.startTime ?? undefined, endTime: s.endTime ?? undefined, requiredMinutes: s.requiredMinutes ?? undefined, coreStart: s.coreStart ?? undefined, coreEnd: s.coreEnd ?? undefined,
    dayBoundary: s.dayBoundary, breaks: s.breaks ?? [], punchInWindowBeforeMinutes: s.punchInWindowBeforeMinutes, punchOutWindowAfterMinutes: s.punchOutWindowAfterMinutes, graceInMinutes: s.graceInMinutes, graceOutMinutes: s.graceOutMinutes, color: s.color ?? undefined, status: s.status as FormValues['status'],
  };
}

/** A block of the form that can be switched on or off on its own: the switch and what it does, with the fields only while it is on. */
function OptionalBlock({ title, hint, on, onChange, testId, children }: { title: string; hint: string; on: boolean; onChange: (on: boolean) => void; testId: string; children?: ReactNode }) {
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={testId}>
      <label className="flex items-start gap-3">
        <Switch className="mt-0.5" checked={on} onCheckedChange={onChange} aria-label={title} />
        <span className="space-y-0.5">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      </label>
      {on ? children : null}
    </div>
  );
}

/**
 * Switch state of one optional block. Switching off puts the field back to its "off" value (so a hidden field can never block the
 * save and always saves as off); switching on again brings back what had been typed, or `fresh` the first time.
 */
function useBlockSwitch(setValue: UseFormSetValue<FormValues>, getValues: UseFormGetValues<FormValues>, name: keyof FormValues & string, initial: boolean, off: unknown, fresh: unknown) {
  const [on, setOn] = useState(initial);
  const kept = useRef<unknown>(undefined);
  const toggle = (next: boolean) => {
    if (next) setValue(name, (kept.current ?? fresh) as never, { shouldDirty: true });
    else { kept.current = getValues(name); setValue(name, off as never, { shouldDirty: true }); }
    setOn(next);
  };
  return [on, toggle] as const;
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
  const { register, control, setValue, getValues, setError, formState: { errors, isSubmitting } } = form;
  const type = useWatch({ control, name: 'type' }) ?? 'FIXED';
  const color = useWatch({ control, name: 'color' });
  // Core hours are opt-in: they only apply while switched on; switched off they are cleared on save (null), never left behind.
  const [coreOn, setCoreOn] = useState(() => !!(shift?.coreStart || shift?.coreEnd));
  const coreStart = useWatch({ control, name: 'coreStart' });
  const coreEnd = useWatch({ control, name: 'coreEnd' });
  const flex = flexibleGuide(useWatch({ control, name: 'requiredMinutes' }), coreOn ? coreStart : null, coreOn ? coreEnd : null, useWatch({ control, name: 'breaks' }));
  const boundary = dayBoundaryGuide(useWatch({ control, name: 'dayBoundary' }));
  // Every optional block has its own switch. Off = the field is at its "off" value: no breaks, the platform default punch window,
  // the rule set's grace (null), no colour. A saved shift opens with a block on exactly when it differs from that.
  const [breaksOn, toggleBreaks] = useBlockSwitch(setValue, getValues, 'breaks', (shift?.breaks?.length ?? 0) > 0, [], []);
  const [punchInOn, togglePunchIn] = useBlockSwitch(setValue, getValues, 'punchInWindowBeforeMinutes', !!shift && shift.punchInWindowBeforeMinutes !== DEFAULT_PUNCH_IN_WINDOW_MINUTES, DEFAULT_PUNCH_IN_WINDOW_MINUTES, DEFAULT_PUNCH_IN_WINDOW_MINUTES);
  const [punchOutOn, togglePunchOut] = useBlockSwitch(setValue, getValues, 'punchOutWindowAfterMinutes', !!shift && shift.punchOutWindowAfterMinutes !== DEFAULT_PUNCH_OUT_WINDOW_MINUTES, DEFAULT_PUNCH_OUT_WINDOW_MINUTES, DEFAULT_PUNCH_OUT_WINDOW_MINUTES);
  const [graceInOn, toggleGraceIn] = useBlockSwitch(setValue, getValues, 'graceInMinutes', shift?.graceInMinutes != null, null, DEFAULT_ATTENDANCE_RULES.graceInMinutes);
  const [graceOutOn, toggleGraceOut] = useBlockSwitch(setValue, getValues, 'graceOutMinutes', shift?.graceOutMinutes != null, null, DEFAULT_ATTENDANCE_RULES.graceOutMinutes);
  const [colorOn, toggleColor] = useBlockSwitch(setValue, getValues, 'color', shift ? !!shift.color : true, undefined, COLORS[0]);
  const onSubmit = form.handleSubmit(async (values) => {
    if (type === 'FLEXIBLE' && coreOn && (!values.coreStart || !values.coreEnd)) {
      setError(values.coreStart ? 'coreEnd' : 'coreStart', { message: t('shifts.coreBothNeeded') });
      return;
    }
    const needsMinutes = (on: boolean, v: unknown, field: 'graceInMinutes' | 'graceOutMinutes') => { if (!on || (v !== null && v !== undefined)) return false; setError(field, { message: t('shifts.minutesNeeded') }); return true; };
    if (needsMinutes(graceInOn, values.graceInMinutes, 'graceInMinutes') || needsMinutes(graceOutOn, values.graceOutMinutes, 'graceOutMinutes')) return;
    try {
      // `color: null` (not omitted) so a switched-off colour is cleared on PATCH, like the core hours.
      const shared = { ...values, color: colorOn ? values.color ?? null : null };
      const input: ShiftInput = type === 'FIXED'
        ? { ...shared, requiredMinutes: undefined, coreStart: null, coreEnd: null }
        : { ...shared, startTime: undefined, endTime: undefined, ...(coreOn ? {} : { coreStart: null, coreEnd: null }) };
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

                <OptionalBlock title={t('shifts.useCore')} hint={coreOn ? t('shifts.coreHint') : t('shifts.coreOffHint')} on={coreOn} onChange={setCoreOn} testId="core-hours">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField label={t('shifts.coreStart')} htmlFor="sh-cstart" required error={errors.coreStart?.message}><Input id="sh-cstart" type="time" dir="ltr" className="tnum" {...register('coreStart', { setValueAs: blankToUndefined })} aria-invalid={!!errors.coreStart} /></FormField>
                    <FormField label={t('shifts.coreEnd')} htmlFor="sh-cend" required error={errors.coreEnd?.message}><Input id="sh-cend" type="time" dir="ltr" className="tnum" {...register('coreEnd', { setValueAs: blankToUndefined })} aria-invalid={!!errors.coreEnd} /></FormField>
                  </div>
                  {coreOn && flex.coreTooLong ? <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" role="status">{t('shifts.coreLongerThanRequired', flex.coreTooLong)}</p> : null}
                </OptionalBlock>
              </div>
            )}
          </section>

          <section>
            <OptionalBlock title={t('shifts.breaks')} hint={breaksOn ? t('shifts.breaksOnHint') : t('shifts.breaksOffHint')} on={breaksOn} onChange={toggleBreaks} testId="breaks-block">
              <Controller control={control} name="breaks" render={({ field }) => <BreaksEditor value={(field.value ?? []) as ShiftInput['breaks']} onChange={field.onChange} />} />
              {typeof errors.breaks?.message === 'string' ? <p className="text-xs text-destructive" role="alert">{errors.breaks.message}</p> : null}
            </OptionalBlock>
          </section>

          <section className="space-y-3">
            <h4 className="text-sm font-semibold">{t('shifts.windows')}</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <OptionalBlock title={t('shifts.punchInTitle')} hint={punchInOn ? t('shifts.punchInWindowHint') : t('shifts.punchInOffHint', { minutes: DEFAULT_PUNCH_IN_WINDOW_MINUTES })} on={punchInOn} onChange={togglePunchIn} testId="punch-in-block">
                <FormField label={t('shifts.punchInWindow')} htmlFor="sh-inwin" error={errors.punchInWindowBeforeMinutes?.message}><Input id="sh-inwin" type="number" min={0} max={720} dir="ltr" className="tnum" {...register('punchInWindowBeforeMinutes', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.punchInWindowBeforeMinutes} /></FormField>
              </OptionalBlock>
              <OptionalBlock title={t('shifts.punchOutTitle')} hint={punchOutOn ? t('shifts.punchOutWindowHint') : t('shifts.punchOutOffHint', { minutes: DEFAULT_PUNCH_OUT_WINDOW_MINUTES })} on={punchOutOn} onChange={togglePunchOut} testId="punch-out-block">
                <FormField label={t('shifts.punchOutWindow')} htmlFor="sh-outwin" error={errors.punchOutWindowAfterMinutes?.message}><Input id="sh-outwin" type="number" min={0} max={720} dir="ltr" className="tnum" {...register('punchOutWindowAfterMinutes', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.punchOutWindowAfterMinutes} /></FormField>
              </OptionalBlock>
              <OptionalBlock title={t('shifts.graceInTitle')} hint={graceInOn ? t('shifts.graceHint') : t('shifts.graceOffHint')} on={graceInOn} onChange={toggleGraceIn} testId="grace-in-block">
                <FormField label={t('shifts.graceIn')} htmlFor="sh-gin" error={errors.graceInMinutes?.message}><Input id="sh-gin" type="number" min={0} max={240} dir="ltr" className="tnum" {...register('graceInMinutes', { setValueAs: (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v)) })} aria-invalid={!!errors.graceInMinutes} /></FormField>
              </OptionalBlock>
              <OptionalBlock title={t('shifts.graceOutTitle')} hint={graceOutOn ? t('shifts.graceHint') : t('shifts.graceOffHint')} on={graceOutOn} onChange={toggleGraceOut} testId="grace-out-block">
                <FormField label={t('shifts.graceOut')} htmlFor="sh-gout" error={errors.graceOutMinutes?.message}><Input id="sh-gout" type="number" min={0} max={240} dir="ltr" className="tnum" {...register('graceOutMinutes', { setValueAs: (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v)) })} aria-invalid={!!errors.graceOutMinutes} /></FormField>
              </OptionalBlock>
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <OptionalBlock title={t('shifts.color')} hint={colorOn ? t('shifts.colorOnHint') : t('shifts.colorOffHint')} on={colorOn} onChange={toggleColor} testId="color-block">
              <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('shifts.color')}>
                {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={cn('size-7 rounded-full border-2 transition-transform focus-visible:ring-2 focus-visible:ring-ring', color === c ? 'scale-110 border-foreground' : 'border-transparent')} style={{ backgroundColor: c }} onClick={() => setValue('color', c, { shouldDirty: true })} />)}
                <Input id="sh-color" dir="ltr" className="h-8 w-28 font-mono text-xs" placeholder="#0f6e56" aria-label={t('shifts.colorCode')} {...register('color', { setValueAs: blankToUndefined })} aria-invalid={!!errors.color} />
              </div>
              {errors.color?.message ? <p className="text-xs text-destructive" role="alert">{errors.color.message}</p> : null}
            </OptionalBlock>
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
