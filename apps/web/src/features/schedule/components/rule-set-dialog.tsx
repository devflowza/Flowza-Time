import { Controller, useForm, useWatch, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { MISSING_PUNCH_BEHAVIORS, PUNCH_INTERPRETATIONS, ROUNDING_MODES, attendanceRuleSetInputSchema, DEFAULT_ATTENDANCE_RULES, type AttendanceRuleSetInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { blankToUndefined, toNumber } from '@/features/organization/form-utils';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useRuleSetMutations } from '../api';
import type { RuleSetDto } from '../types';

type FormValues = z.input<typeof attendanceRuleSetInputSchema>;
type NumKey = 'graceInMinutes' | 'graceOutMinutes' | 'lateThresholdMinutes' | 'earlyDepartureThresholdMinutes' | 'minFullDayMinutes' | 'halfDayThresholdMinutes' | 'overtimeStartAfterMinutes' | 'overtimeMinBlockMinutes' | 'duplicatePunchWindowSeconds';
type BoolKey = 'overtimeEnabled' | 'countEarlyInAsOvertime' | 'autoAbsentWithoutPunches' | 'weeklyOffWorkCountsAsOvertime' | 'holidayWorkCountsAsOvertime';
const OT_ROUNDING = [0, 5, 10, 15, 30, 60] as const;
const PUNCH_ROUNDING = [0, 5, 10, 15, 30] as const;

function toDefaults(r: RuleSetDto | null, today: string): FormValues {
  if (!r) return { ...DEFAULT_ATTENDANCE_RULES, name: '', branchId: null, effectiveFrom: today, effectiveTo: null, overtimeMaxMinutesPerDay: null };
  const { id: _id, version: _v, createdAt: _c, updatedAt: _u, ...rules } = r;
  return { ...DEFAULT_ATTENDANCE_RULES, ...rules, ramadanMode: { ...DEFAULT_ATTENDANCE_RULES.ramadanMode, ...(rules.ramadanMode ?? {}) } };
}

function Num({ name, label, hint, id, register, errors, min, max }: { name: NumKey; label: string; hint?: string; id: string; register: UseFormRegister<FormValues>; errors: FieldErrors<FormValues>; min?: number; max?: number }) {
  return <FormField label={label} htmlFor={id} hint={hint} error={errors[name]?.message}><Input id={id} type="number" min={min ?? 0} max={max} dir="ltr" className="tnum" {...register(name, { setValueAs: toNumber })} aria-invalid={!!errors[name]} /></FormField>;
}
function Bool({ name, label, hint, id, control }: { name: BoolKey; label: string; hint?: string; id: string; control: Control<FormValues> }) {
  return (
    <Controller control={control} name={name} render={({ field }) => (
      <div className="flex items-center justify-between gap-4 rounded-md border p-3">
        <div className="min-w-0"><label htmlFor={id} className="text-sm font-medium">{label}</label>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>
        <Switch id={id} checked={!!field.value} onCheckedChange={field.onChange} />
      </div>
    )} />
  );
}
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <section className="space-y-3 rounded-lg border p-4"><div><h4 className="text-sm font-semibold">{title}</h4>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>{children}</section>;
}

/** Effective-dated attendance rule set (attendanceRuleSetInputSchema), grouped: grace & thresholds / overtime / rounding / punch interpretation / missing punch / Ramadan. */
export function RuleSetDialog({ open, onOpenChange, ruleSet }: { open: boolean; onOpenChange: (o: boolean) => void; ruleSet: RuleSetDto | null }) {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const branches = useBranchOptions();
  const { create, update } = useRuleSetMutations();
  const form = useForm<FormValues, unknown, AttendanceRuleSetInput>({ resolver: zodResolver(attendanceRuleSetInputSchema), defaultValues: toDefaults(ruleSet, todayIso(tz)) });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const otEnabled = useWatch({ control, name: 'overtimeEnabled' }) ?? true;
  const ramadan = useWatch({ control, name: 'ramadanMode.enabled' }) ?? false;
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const res = ruleSet ? await update.mutateAsync({ id: ruleSet.id, input: values }) : await create.mutateAsync(values);
      if (res.recalculationJobId) toastJobQueued(res.recalculationJobId, navigate, t('rules.recalcHint')); else toast.success(ruleSet ? t('rules.updated') : t('rules.created'));
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  const n = (name: NumKey, key: string, opts: { min?: number; max?: number; hint?: boolean } = {}) => <Num key={name} name={name} id={`rs-${name}`} label={t(`rules.fields.${key}`)} hint={opts.hint ? t(`rules.hints.${key}`) : undefined} register={register} errors={errors} min={opts.min} max={opts.max} />;
  const b = (name: BoolKey, key: string) => <Bool key={name} name={name} id={`rs-${name}`} label={t(`rules.fields.${key}`)} hint={t(`rules.hints.${key}`)} control={control} />;
  const roundingSelect = (name: 'overtimeRoundingMinutes' | 'punchRoundingMinutes' | 'workedRoundingMinutes', values: readonly number[], label: string) => (
    <FormField label={label} htmlFor={`rs-${name}`} error={errors[name]?.message}>
      <Controller control={control} name={name} render={({ field }) => (
        <Select value={String(field.value ?? 0)} onValueChange={(v) => field.onChange(Number(v))}>
          <SelectTrigger id={`rs-${name}`}><SelectValue /></SelectTrigger>
          <SelectContent>{values.map((v) => <SelectItem key={v} value={String(v)}>{v === 0 ? t('rules.noRounding') : t('rules.minutesValue', { count: v })}</SelectItem>)}</SelectContent>
        </Select>
      )} />
    </FormField>
  );
  const modeSelect = (name: 'punchRoundingMode' | 'workedRoundingMode', label: string) => (
    <FormField label={label} htmlFor={`rs-${name}`} error={errors[name]?.message}>
      <Controller control={control} name={name} render={({ field }) => (
        <Select value={field.value ?? 'NONE'} onValueChange={field.onChange}>
          <SelectTrigger id={`rs-${name}`}><SelectValue /></SelectTrigger>
          <SelectContent>{ROUNDING_MODES.map((m) => <SelectItem key={m} value={m}>{t(`rules.roundingModes.${m}`)}</SelectItem>)}</SelectContent>
        </Select>
      )} />
    </FormField>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader><DialogTitle>{ruleSet ? t('rules.edit') : t('rules.add')}</DialogTitle><DialogDescription>{t('rules.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label={tc('common.name')} htmlFor="rs-name" required error={errors.name?.message}><Input id="rs-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={tc('common.branch')} htmlFor="rs-branch" optional hint={ruleSet ? t('rules.branchImmutable') : t('rules.branchHint')} error={errors.branchId?.message}>
              <Controller control={control} name="branchId" render={({ field }) => <Combobox id="rs-branch" value={field.value ?? null} onChange={(v) => field.onChange(v)} options={branches.options} loading={branches.isLoading} clearable={!ruleSet} disabled={!!ruleSet} placeholder={t('rules.orgWide')} />} />
            </FormField>
            <FormField label={t('rules.effectiveFrom')} htmlFor="rs-from" required error={errors.effectiveFrom?.message}><Input id="rs-from" type="date" dir="ltr" {...register('effectiveFrom')} aria-invalid={!!errors.effectiveFrom} /></FormField>
            <FormField label={t('rules.effectiveTo')} htmlFor="rs-to" optional error={errors.effectiveTo?.message}><Input id="rs-to" type="date" dir="ltr" {...register('effectiveTo', { setValueAs: (v: unknown) => (v === '' ? null : v) })} /></FormField>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={t('rules.sections.grace')} hint={t('rules.sections.graceHint')}>
              <div className="grid gap-3 sm:grid-cols-2">
                {n('graceInMinutes', 'graceInMinutes', { max: 240 })}{n('graceOutMinutes', 'graceOutMinutes', { max: 240 })}
                {n('lateThresholdMinutes', 'lateThresholdMinutes', { max: 480, hint: true })}{n('earlyDepartureThresholdMinutes', 'earlyDepartureThresholdMinutes', { max: 480 })}
                {n('minFullDayMinutes', 'minFullDayMinutes', { max: 1440, hint: true })}{n('halfDayThresholdMinutes', 'halfDayThresholdMinutes', { max: 1440, hint: true })}
              </div>
            </Section>
            <Section title={t('rules.sections.overtime')} hint={t('rules.sections.overtimeHint')}>
              {b('overtimeEnabled', 'overtimeEnabled')}
              <div className={`grid gap-3 sm:grid-cols-2 ${otEnabled ? '' : 'opacity-50'}`}>
                {n('overtimeStartAfterMinutes', 'overtimeStartAfterMinutes', { max: 480, hint: true })}{n('overtimeMinBlockMinutes', 'overtimeMinBlockMinutes', { max: 480, hint: true })}
                {roundingSelect('overtimeRoundingMinutes', OT_ROUNDING, t('rules.fields.overtimeRoundingMinutes'))}
                <FormField label={t('rules.fields.overtimeMaxMinutesPerDay')} htmlFor="rs-otmax" optional hint={t('rules.hints.overtimeMaxMinutesPerDay')} error={errors.overtimeMaxMinutesPerDay?.message}><Input id="rs-otmax" type="number" min={0} max={1440} dir="ltr" className="tnum" placeholder={t('rules.noLimit')} {...register('overtimeMaxMinutesPerDay', { setValueAs: (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v)) })} /></FormField>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">{b('countEarlyInAsOvertime', 'countEarlyInAsOvertime')}{b('weeklyOffWorkCountsAsOvertime', 'weeklyOffWorkCountsAsOvertime')}{b('holidayWorkCountsAsOvertime', 'holidayWorkCountsAsOvertime')}</div>
            </Section>
            <Section title={t('rules.sections.rounding')} hint={t('rules.sections.roundingHint')}>
              <div className="grid gap-3 sm:grid-cols-2">
                {roundingSelect('punchRoundingMinutes', PUNCH_ROUNDING, t('rules.fields.punchRoundingMinutes'))}{modeSelect('punchRoundingMode', t('rules.fields.punchRoundingMode'))}
                {roundingSelect('workedRoundingMinutes', PUNCH_ROUNDING, t('rules.fields.workedRoundingMinutes'))}{modeSelect('workedRoundingMode', t('rules.fields.workedRoundingMode'))}
              </div>
            </Section>
            <Section title={t('rules.sections.punches')} hint={t('rules.sections.punchesHint')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label={t('rules.fields.punchInterpretation')} htmlFor="rs-interp" hint={t('rules.hints.punchInterpretation')} error={errors.punchInterpretation?.message}>
                  <Controller control={control} name="punchInterpretation" render={({ field }) => (
                    <Select value={field.value ?? 'FIRST_LAST'} onValueChange={field.onChange}><SelectTrigger id="rs-interp"><SelectValue /></SelectTrigger><SelectContent>{PUNCH_INTERPRETATIONS.map((m) => <SelectItem key={m} value={m}>{t(`rules.interpretations.${m}`)}</SelectItem>)}</SelectContent></Select>
                  )} />
                </FormField>
                {n('duplicatePunchWindowSeconds', 'duplicatePunchWindowSeconds', { max: 3600, hint: true })}
              </div>
            </Section>
            <Section title={t('rules.sections.missing')} hint={t('rules.sections.missingHint')}>
              <FormField label={t('rules.fields.missingPunchBehavior')} htmlFor="rs-missing" error={errors.missingPunchBehavior?.message}>
                <Controller control={control} name="missingPunchBehavior" render={({ field }) => (
                  <Select value={field.value ?? 'FLAG_ONLY'} onValueChange={field.onChange}><SelectTrigger id="rs-missing"><SelectValue /></SelectTrigger><SelectContent>{MISSING_PUNCH_BEHAVIORS.map((m) => <SelectItem key={m} value={m}>{t(`rules.missingBehaviors.${m}`)}</SelectItem>)}</SelectContent></Select>
                )} />
              </FormField>
              {b('autoAbsentWithoutPunches', 'autoAbsentWithoutPunches')}
            </Section>
            <Section title={t('rules.sections.ramadan')} hint={t('rules.sections.ramadanHint')}>
              <Controller control={control} name="ramadanMode.enabled" render={({ field }) => (
                <div className="flex items-center justify-between gap-4 rounded-md border p-3"><label htmlFor="rs-ram" className="text-sm font-medium">{t('rules.fields.ramadanEnabled')}</label><Switch id="rs-ram" checked={!!field.value} onCheckedChange={field.onChange} /></div>
              )} />
              <div className={`grid gap-3 sm:grid-cols-2 ${ramadan ? '' : 'opacity-50'}`}>
                <FormField label={tc('common.from')} htmlFor="rs-ram-from" error={errors.ramadanMode?.from?.message}><Input id="rs-ram-from" type="date" dir="ltr" disabled={!ramadan} {...register('ramadanMode.from', { setValueAs: blankToUndefined })} /></FormField>
                <FormField label={tc('common.to')} htmlFor="rs-ram-to" error={errors.ramadanMode?.to?.message}><Input id="rs-ram-to" type="date" dir="ltr" disabled={!ramadan} {...register('ramadanMode.to', { setValueAs: blankToUndefined })} /></FormField>
                <FormField label={t('rules.fields.ramadanMinutes')} htmlFor="rs-ram-min" hint={t('rules.hints.ramadanMinutes')} error={errors.ramadanMode?.scheduledMinutes?.message}><Input id="rs-ram-min" type="number" min={60} max={600} dir="ltr" className="tnum" disabled={!ramadan} {...register('ramadanMode.scheduledMinutes', { setValueAs: (v: unknown) => (v === '' || v === null || v === undefined ? undefined : Number(v)) })} /></FormField>
                <FormField label={t('rules.fields.ramadanAppliesTo')} htmlFor="rs-ram-applies" error={errors.ramadanMode?.appliesTo?.message}>
                  <Controller control={control} name="ramadanMode.appliesTo" render={({ field }) => (
                    <Select value={field.value ?? 'all'} onValueChange={field.onChange} disabled={!ramadan}><SelectTrigger id="rs-ram-applies"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('rules.ramadanAll')}</SelectItem><SelectItem value="flagged_employees">{t('rules.ramadanFlagged')}</SelectItem></SelectContent></Select>
                  )} />
                </FormField>
              </div>
            </Section>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{ruleSet ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
