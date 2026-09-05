import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { shiftPatternInputSchema, type ShiftPatternInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { toNumber } from '@/features/organization/form-utils';
import { usePatternMutations, useShiftOptions } from '../api';
import type { PatternEntry, ShiftDto, ShiftPatternDto } from '../types';

type FormValues = z.input<typeof shiftPatternInputSchema>;
const OFF = '__off__';

/** Day-by-day picker: one Select per cycle day (Off or a shift). Entries are normalised to exactly `cycle` days. */
function SequenceEditor({ cycle, value, onChange, shifts, byId }: { cycle: number; value: PatternEntry[]; onChange: (v: PatternEntry[]) => void; shifts: { value: string; label: string }[]; byId: Map<string, ShiftDto> }) {
  const { t } = useTranslation('schedule');
  const days = Array.from({ length: Math.max(1, Math.min(cycle || 1, 366)) }, (_, i) => i);
  const entryFor = (d: number) => value.find((e) => e.day === d);
  const set = (d: number, v: string) => {
    const next: PatternEntry = v === OFF ? { day: d, off: true } : { day: d, shiftId: v };
    onChange([...value.filter((e) => e.day !== d && e.day < days.length), next].sort((a, b) => a.day - b.day));
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label={t('patterns.sequence')}>
      {days.map((d) => {
        const e = entryFor(d);
        const shift = e && 'shiftId' in e ? byId.get(e.shiftId) : undefined;
        const current = e ? ('off' in e ? OFF : e.shiftId) : OFF;
        return (
          <div key={d} className={cn('flex items-center gap-2 rounded-md border p-1.5 ps-2', current === OFF && 'bg-muted/40')}>
            <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground tnum">{t('patterns.day', { n: d + 1 })}</span>
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: shift?.color ?? 'transparent' }} aria-hidden />
            <Select value={current} onValueChange={(v) => set(d, v)}>
              <SelectTrigger className="h-8 flex-1" aria-label={t('patterns.dayShift', { n: d + 1 })}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={OFF}>{t('patterns.off')}</SelectItem>{shifts.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}

function toDefaults(p: ShiftPatternDto | null, today: string): FormValues {
  if (!p) return { code: '', name: '', cycleLengthDays: 7, sequence: Array.from({ length: 7 }, (_, d) => ({ day: d, off: true as const })), anchorDate: today };
  return { code: p.code, name: p.name, cycleLengthDays: p.cycleLengthDays, sequence: p.sequence, anchorDate: p.anchorDate };
}

/** Rotational pattern editor (shiftPatternInputSchema): cycle length, anchor date and a shift/off per cycle day. */
export function PatternDialog({ open, onOpenChange, pattern }: { open: boolean; onOpenChange: (o: boolean) => void; pattern: ShiftPatternDto | null }) {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const shifts = useShiftOptions();
  const { create, update } = usePatternMutations();
  const form = useForm<FormValues, unknown, ShiftPatternInput>({ resolver: zodResolver(shiftPatternInputSchema), defaultValues: toDefaults(pattern, todayIso(tz)) });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const cycle = Number(useWatch({ control, name: 'cycleLengthDays' }) ?? 7);
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const sequence = values.sequence.filter((e) => e.day < values.cycleLengthDays);
      const input = { ...values, sequence: sequence.length ? sequence : [{ day: 0, off: true as const }] };
      if (pattern) { await update.mutateAsync({ id: pattern.id, input }); toast.success(t('patterns.updated')); }
      else { await create.mutateAsync(input); toast.success(t('patterns.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{pattern ? t('patterns.edit') : t('patterns.add')}</DialogTitle><DialogDescription>{t('patterns.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label={tc('common.code')} htmlFor="pt-code" required error={errors.code?.message}><Input id="pt-code" dir="ltr" className="font-mono" {...register('code')} aria-invalid={!!errors.code} disabled={!!pattern} /></FormField>
            <FormField label={tc('common.name')} htmlFor="pt-name" required error={errors.name?.message}><Input id="pt-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={t('patterns.cycleLength')} htmlFor="pt-cycle" required error={errors.cycleLengthDays?.message} hint={t('patterns.cycleLengthHint')}><Input id="pt-cycle" type="number" min={1} max={366} dir="ltr" className="tnum" {...register('cycleLengthDays', { setValueAs: toNumber })} aria-invalid={!!errors.cycleLengthDays} /></FormField>
            <FormField label={t('patterns.anchorDate')} htmlFor="pt-anchor" required error={errors.anchorDate?.message} hint={t('patterns.anchorDateHint')}><Input id="pt-anchor" type="date" dir="ltr" {...register('anchorDate')} aria-invalid={!!errors.anchorDate} /></FormField>
          </div>
          <section className="space-y-2">
            <h4 className="text-sm font-semibold">{t('patterns.sequence')}</h4>
            {shifts.options.length === 0 && !shifts.isLoading ? <p className="text-xs text-amber-700">{t('patterns.noShifts')}</p> : null}
            <Controller control={control} name="sequence" render={({ field }) => <SequenceEditor cycle={cycle} value={(field.value ?? []) as PatternEntry[]} onChange={field.onChange} shifts={shifts.options} byId={shifts.byId} />} />
            {typeof errors.sequence?.message === 'string' ? <p className="text-xs text-destructive" role="alert">{errors.sequence.message}</p> : null}
          </section>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{pattern ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
