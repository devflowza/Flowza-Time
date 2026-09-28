import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { EMPLOYMENT_TYPES, LEAVE_ACCRUALS, LEAVE_APPLICABLE_GENDERS, LEAVE_COUNT_MODES, leaveTypeInputSchema } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { blankToUndefined } from '@/features/organization/form-utils';
import { useLeaveMutations, type LeaveTypeInput } from '../api';
import type { LeaveTypeDto } from '../types';

type FormValues = z.input<typeof leaveTypeInputSchema>;
const COLORS = ['#175cd3', '#0f6e56', '#b54708', '#7a2e9d', '#b42318', '#0e7490', '#475467'];
const numberOrNull = (v: unknown): unknown => (v === '' || v === null || v === undefined ? null : Number(v));
const numberOrZero = (v: unknown): unknown => (v === '' || v === null || v === undefined ? 0 : Number(v));

function SwitchField({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div><Label htmlFor={id}>{label}</Label><p className="text-xs text-muted-foreground">{hint}</p></div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/**
 * Create or edit a leave type with its leave v2 policy: approval, how days are counted, half days, who may take it and
 * whether employees can apply in the portal; the yearly entitlement, monthly accrual and the carry-forward into next year.
 * The organisation's comp-off type is managed by the system — only its name and colour can change.
 */
export function LeaveTypeDialog({ open, onOpenChange, leaveType }: { open: boolean; onOpenChange: (o: boolean) => void; leaveType: LeaveTypeDto | null }) {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const { t: te } = useTranslation('employees');
  const { createType, updateType } = useLeaveMutations();
  const system = !!leaveType?.compOff;
  const form = useForm<FormValues, unknown, LeaveTypeInput>({
    resolver: zodResolver(leaveTypeInputSchema),
    defaultValues: leaveType
      ? {
          code: leaveType.code, name: leaveType.name, nameAr: leaveType.nameAr ?? undefined, isPaid: leaveType.isPaid, treatAsPresent: leaveType.treatAsPresent ?? false, color: leaveType.color ?? undefined, annualAllowanceDays: leaveType.annualAllowanceDays ?? null,
          requiresApproval: leaveType.requiresApproval ?? true, countMode: leaveType.countMode ?? 'working', maxConsecutiveDays: leaveType.maxConsecutiveDays ?? null, advanceNoticeDays: leaveType.advanceNoticeDays ?? 0, applicableGender: leaveType.applicableGender ?? 'all',
          applicableEmploymentTypes: (leaveType.applicableEmploymentTypes ?? null) as FormValues['applicableEmploymentTypes'],
          accrual: leaveType.accrual ?? 'none', carryForwardMaxDays: leaveType.carryForwardMaxDays ?? 0, carryForwardExpiryMonths: leaveType.carryForwardExpiryMonths ?? null, isSpecial: leaveType.isSpecial ?? false, allowHalfDay: leaveType.allowHalfDay ?? true, portalVisible: leaveType.portalVisible ?? true,
        }
      : { code: '', name: '', isPaid: true, treatAsPresent: false, color: COLORS[0], annualAllowanceDays: null, requiresApproval: true, countMode: 'working', maxConsecutiveDays: null, advanceNoticeDays: 0, applicableGender: 'all', applicableEmploymentTypes: null, accrual: 'none', carryForwardMaxDays: 0, carryForwardExpiryMonths: null, isSpecial: false, allowHalfDay: true, portalVisible: true },
  });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const color = useWatch({ control, name: 'color' });
  const carryForward = Number(useWatch({ control, name: 'carryForwardMaxDays' }) ?? 0);
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      // the comp-off type keeps its system policy: only the labels and the colour are editable
      if (leaveType && system) { await updateType.mutateAsync({ id: leaveType.id, input: { name: v.name, nameAr: v.nameAr, color: v.color } }); toast.success(t('types.updated')); }
      else if (leaveType) { await updateType.mutateAsync({ id: leaveType.id, input: v }); toast.success(t('types.updated')); }
      else { await createType.mutateAsync(v); toast.success(t('types.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  const sw = (name: 'isPaid' | 'treatAsPresent' | 'requiresApproval' | 'allowHalfDay' | 'portalVisible' | 'isSpecial', fallback: boolean) => (
    <Controller control={control} name={name} render={({ field }) => <SwitchField id={`lt-${name}`} label={t(`fields.${name}`)} hint={t(`fields.${name}Hint`)} checked={field.value ?? fallback} onChange={field.onChange} disabled={system} />} />
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{leaveType ? t('types.edit') : t('types.add')}</DialogTitle><DialogDescription>{system ? t('types.systemHint') : t('types.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={tc('common.code')} htmlFor="lt-code" required error={errors.code?.message}><Input id="lt-code" dir="ltr" className="font-mono" {...register('code')} aria-invalid={!!errors.code} disabled={!!leaveType} /></FormField>
            <FormField label={tc('common.name')} htmlFor="lt-name" required error={errors.name?.message}><Input id="lt-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={t('fields.nameAr')} htmlFor="lt-nameAr" optional error={errors.nameAr?.message}><Input id="lt-nameAr" dir="rtl" {...register('nameAr', { setValueAs: blankToUndefined })} /></FormField>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">{sw('isPaid', true)}{sw('treatAsPresent', false)}</div>

          <fieldset className="space-y-3" disabled={system}>
            <legend className="text-sm font-semibold">{t('types.policy.requests')}</legend>
            <div className="grid gap-3 sm:grid-cols-2">{sw('requiresApproval', true)}{sw('allowHalfDay', true)}{sw('portalVisible', true)}{sw('isSpecial', false)}</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('fields.countMode')} htmlFor="lt-count" hint={t('fields.countModeHint')}>
                <Controller control={control} name="countMode" render={({ field }) => (
                  <Select value={field.value ?? 'working'} onValueChange={field.onChange} disabled={system}><SelectTrigger id="lt-count"><SelectValue /></SelectTrigger><SelectContent>{LEAVE_COUNT_MODES.map((m) => <SelectItem key={m} value={m}>{t(`countModes.${m}`)}</SelectItem>)}</SelectContent></Select>
                )} />
              </FormField>
              <FormField label={t('fields.applicableGender')} htmlFor="lt-gender" hint={t('fields.applicableGenderHint')}>
                <Controller control={control} name="applicableGender" render={({ field }) => (
                  <Select value={field.value ?? 'all'} onValueChange={field.onChange} disabled={system}><SelectTrigger id="lt-gender"><SelectValue /></SelectTrigger><SelectContent>{LEAVE_APPLICABLE_GENDERS.map((g) => <SelectItem key={g} value={g}>{t(`genders.${g}`)}</SelectItem>)}</SelectContent></Select>
                )} />
              </FormField>
              <FormField label={t('fields.applicableEmploymentTypes')} htmlFor="lt-emp-types" hint={t('fields.applicableEmploymentTypesHint')} error={errors.applicableEmploymentTypes?.message} className="sm:col-span-2">
                <Controller control={control} name="applicableEmploymentTypes" render={({ field }) => {
                  // none ticked = every employment type (stored as null); B-41 employee-type applicability
                  const selected = field.value ?? [];
                  const toggle = (type: (typeof EMPLOYMENT_TYPES)[number], on: boolean) => {
                    const next = on ? [...selected, type] : selected.filter((x) => x !== type);
                    field.onChange(next.length ? EMPLOYMENT_TYPES.filter((x) => next.includes(x)) : null);
                  };
                  return (
                    <div id="lt-emp-types" role="group" aria-label={t('fields.applicableEmploymentTypes')} className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
                      {EMPLOYMENT_TYPES.map((type) => (
                        <Label key={type} className="flex items-center gap-2 text-sm font-normal">
                          <Checkbox checked={selected.includes(type)} onCheckedChange={(v) => toggle(type, v === true)} disabled={system} aria-label={te(`employmentType.${type}`)} />
                          {te(`employmentType.${type}`)}
                        </Label>
                      ))}
                    </div>
                  );
                }} />
              </FormField>
              <FormField label={t('fields.advanceNoticeDays')} htmlFor="lt-notice" hint={t('fields.advanceNoticeDaysHint')} error={errors.advanceNoticeDays?.message}>
                <Input id="lt-notice" type="number" inputMode="numeric" min={0} max={365} step={1} dir="ltr" className="w-32 tnum" {...register('advanceNoticeDays', { setValueAs: numberOrZero })} aria-invalid={!!errors.advanceNoticeDays} />
              </FormField>
              <FormField label={t('fields.maxConsecutiveDays')} htmlFor="lt-max" optional hint={t('fields.maxConsecutiveDaysHint')} error={errors.maxConsecutiveDays?.message}>
                <Input id="lt-max" type="number" inputMode="numeric" min={1} max={366} step={1} dir="ltr" className="w-32 tnum" {...register('maxConsecutiveDays', { setValueAs: numberOrNull })} aria-invalid={!!errors.maxConsecutiveDays} />
              </FormField>
            </div>
          </fieldset>

          <fieldset className="space-y-3" disabled={system}>
            <legend className="text-sm font-semibold">{t('types.policy.balance')}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('fields.annualAllowance')} htmlFor="lt-allowance" optional hint={t('fields.annualAllowanceHint')} error={errors.annualAllowanceDays?.message}>
                <Input id="lt-allowance" type="number" inputMode="decimal" min={0} max={366} step={0.5} dir="ltr" className="w-32 tnum" {...register('annualAllowanceDays', { setValueAs: numberOrNull })} aria-invalid={!!errors.annualAllowanceDays} />
              </FormField>
              <FormField label={t('fields.accrual')} htmlFor="lt-accrual" hint={t('fields.accrualHint')}>
                <Controller control={control} name="accrual" render={({ field }) => (
                  <Select value={field.value ?? 'none'} onValueChange={field.onChange} disabled={system}><SelectTrigger id="lt-accrual"><SelectValue /></SelectTrigger><SelectContent>{LEAVE_ACCRUALS.map((a) => <SelectItem key={a} value={a}>{t(`accruals.${a}`)}</SelectItem>)}</SelectContent></Select>
                )} />
              </FormField>
              <FormField label={t('fields.carryForwardMaxDays')} htmlFor="lt-cf" hint={t('fields.carryForwardMaxDaysHint')} error={errors.carryForwardMaxDays?.message}>
                <Input id="lt-cf" type="number" inputMode="decimal" min={0} max={366} step={0.5} dir="ltr" className="w-32 tnum" {...register('carryForwardMaxDays', { setValueAs: numberOrZero })} aria-invalid={!!errors.carryForwardMaxDays} />
              </FormField>
              <FormField label={t('fields.carryForwardExpiryMonths')} htmlFor="lt-cf-exp" optional hint={t('fields.carryForwardExpiryMonthsHint')} error={errors.carryForwardExpiryMonths?.message}>
                <Input id="lt-cf-exp" type="number" inputMode="numeric" min={1} max={24} step={1} dir="ltr" className="w-32 tnum" disabled={system || carryForward <= 0} {...register('carryForwardExpiryMonths', { setValueAs: numberOrNull })} aria-invalid={!!errors.carryForwardExpiryMonths} />
              </FormField>
            </div>
          </fieldset>

          <FormField label={t('fields.color')} htmlFor="lt-color" optional error={errors.color?.message}>
            <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('fields.color')}>
              {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={cn('size-7 rounded-full border-2 focus-visible:ring-2 focus-visible:ring-ring', color === c ? 'scale-110 border-foreground' : 'border-transparent')} style={{ backgroundColor: c }} onClick={() => setValue('color', c, { shouldDirty: true })} />)}
              <Input id="lt-color" dir="ltr" className="h-8 w-28 font-mono text-xs" {...register('color', { setValueAs: blankToUndefined })} aria-invalid={!!errors.color} />
            </div>
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{leaveType ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
