import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { TIME_OFF_CATEGORIES, TIME_OFF_GENDERS, timeOffCountsAsWorkByDefault, timeOffTypeInputSchema, type TimeOffTypeDto, type TimeOffTypeInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { blankToUndefined } from '@/features/organization/form-utils';
import { useTimeOffTypeMutations } from '../api';
import { SL_NS } from '../i18n';

type FormValues = z.input<typeof timeOffTypeInputSchema>;
const numberOrNull = (v: unknown): unknown => (v === '' || v === null || v === undefined ? null : Number(v));

function SwitchField({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div><Label htmlFor={id}>{label}</Label><p className="text-xs text-muted-foreground">{hint}</p></div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Create or edit a short leave type: what it is (category; official assignments and remote work count as worked time by
 * default), whether it needs approval and is offered in the portal, who it applies to, and its limits — the longest request and
 * the monthly quota in minutes and / or requests. The code is the type's identity and cannot change once created.
 */
export function TimeOffTypeDialog({ open, onOpenChange, type }: { open: boolean; onOpenChange: (o: boolean) => void; type: TimeOffTypeDto | null }) {
  const { t } = useTranslation(SL_NS);
  const { t: tc } = useTranslation();
  const { create, update } = useTimeOffTypeMutations();
  const form = useForm<FormValues, unknown, TimeOffTypeInput>({
    resolver: zodResolver(timeOffTypeInputSchema),
    defaultValues: type
      ? { code: type.code, name: type.name, nameAr: type.nameAr ?? undefined, category: type.category, countsAsWork: type.countsAsWork, maxMinutesPerRequest: type.maxMinutesPerRequest, monthlyQuotaMinutes: type.monthlyQuotaMinutes, monthlyQuotaCount: type.monthlyQuotaCount, requiresApproval: type.requiresApproval, applicableGender: type.applicableGender, portalVisible: type.portalVisible }
      : { code: '', name: '', category: 'PERSONAL', countsAsWork: false, maxMinutesPerRequest: null, monthlyQuotaMinutes: null, monthlyQuotaCount: null, requiresApproval: true, applicableGender: 'all', portalVisible: true },
  });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      if (type) {
        const { code: _code, ...rest } = v;
        await update.mutateAsync({ id: type.id, input: rest });
        toast.success(t('types.updated'));
      } else {
        await create.mutateAsync(v);
        toast.success(t('types.created'));
      }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  const sw = (name: 'countsAsWork' | 'requiresApproval' | 'portalVisible', fallback: boolean) => (
    <Controller control={control} name={name} render={({ field }) => <SwitchField id={`tot-${name}`} label={t(`fields.${name}`)} hint={t(`fields.${name}Hint`)} checked={field.value ?? fallback} onChange={field.onChange} />} />
  );
  const num = (name: 'maxMinutesPerRequest' | 'monthlyQuotaMinutes' | 'monthlyQuotaCount', max: number) => (
    <FormField label={t(`fields.${name}`)} htmlFor={`tot-${name}`} optional hint={t(`fields.${name}Hint`)} error={errors[name]?.message}>
      <Input id={`tot-${name}`} type="number" inputMode="numeric" min={1} max={max} step={1} dir="ltr" className="w-32 tnum" {...register(name, { setValueAs: numberOrNull })} aria-invalid={!!errors[name]} />
    </FormField>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{type ? t('types.edit') : t('types.add')}</DialogTitle><DialogDescription>{t('types.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={tc('common.code')} htmlFor="tot-code" required error={errors.code?.message}><Input id="tot-code" dir="ltr" className="font-mono" readOnly={!!type} {...register('code')} aria-invalid={!!errors.code} /></FormField>
            <FormField label={tc('common.name')} htmlFor="tot-name" required error={errors.name?.message}><Input id="tot-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={t('fields.nameAr')} htmlFor="tot-nameAr" optional error={errors.nameAr?.message}><Input id="tot-nameAr" dir="rtl" {...register('nameAr', { setValueAs: blankToUndefined })} /></FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('fields.category')} htmlFor="tot-category" required>
              <Controller control={control} name="category" render={({ field }) => (
                // a new type follows its category's default (official / remote work count as work); the switch below can change it
                <Select value={field.value} onValueChange={(v) => { field.onChange(v); if (!type) setValue('countsAsWork', timeOffCountsAsWorkByDefault(v as FormValues['category'])); }}>
                  <SelectTrigger id="tot-category"><SelectValue /></SelectTrigger>
                  <SelectContent>{TIME_OFF_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{t(`categories.${c}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label={t('fields.applicableGender')} htmlFor="tot-gender">
              <Controller control={control} name="applicableGender" render={({ field }) => (
                <Select value={field.value ?? 'all'} onValueChange={field.onChange}><SelectTrigger id="tot-gender"><SelectValue /></SelectTrigger><SelectContent>{TIME_OFF_GENDERS.map((g) => <SelectItem key={g} value={g}>{t(`genders.${g}`)}</SelectItem>)}</SelectContent></Select>
              )} />
            </FormField>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">{sw('countsAsWork', false)}{sw('requiresApproval', true)}{sw('portalVisible', true)}</div>
          <div className="grid gap-4 sm:grid-cols-3">{num('maxMinutesPerRequest', 1440)}{num('monthlyQuotaMinutes', 20000)}{num('monthlyQuotaCount', 100)}</div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{type ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
