import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { HOLIDAY_TYPES, holidayCalendarInputSchema, holidayInputSchema, type HolidayInput } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { blankToUndefined } from '@/features/organization/form-utils';
import { useHolidayMutations, type HolidayCalendarInput } from '../api';
import type { HolidayCalendarDto, HolidayDto } from '../types';

type CalendarValues = z.input<typeof holidayCalendarInputSchema>;
type HolidayValues = z.input<typeof holidayInputSchema>;

export function CalendarDialog({ open, onOpenChange, calendar }: { open: boolean; onOpenChange: (o: boolean) => void; calendar: HolidayCalendarDto | null }) {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const { createCalendar, updateCalendar } = useHolidayMutations();
  const form = useForm<CalendarValues, unknown, HolidayCalendarInput>({ resolver: zodResolver(holidayCalendarInputSchema), defaultValues: calendar ? { name: calendar.name, countryCode: calendar.countryCode ?? undefined, isDefault: calendar.isDefault } : { name: '', countryCode: 'OM', isDefault: false } });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      if (calendar) { await updateCalendar.mutateAsync({ id: calendar.id, input: v }); toast.success(t('holidays.calendarUpdated')); }
      else { await createCalendar.mutateAsync(v); toast.success(t('holidays.calendarCreated')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{calendar ? t('holidays.editCalendar') : t('holidays.addCalendar')}</DialogTitle><DialogDescription>{t('holidays.calendarHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField label={tc('common.name')} htmlFor="cal-name" required error={errors.name?.message}><Input id="cal-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
          <FormField label={t('holidays.countryCode')} htmlFor="cal-country" optional hint={t('holidays.countryCodeHint')} error={errors.countryCode?.message}><Input id="cal-country" dir="ltr" maxLength={2} className="uppercase sm:w-32" {...register('countryCode', { setValueAs: blankToUndefined })} aria-invalid={!!errors.countryCode} /></FormField>
          <Controller control={control} name="isDefault" render={({ field }) => (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3"><div><Label htmlFor="cal-default">{t('holidays.isDefault')}</Label><p className="text-xs text-muted-foreground">{t('holidays.isDefaultHint')}</p></div><Switch id="cal-default" checked={!!field.value} onCheckedChange={field.onChange} /></div>
          )} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{calendar ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Add / edit a holiday (holidayInputSchema): date or range, half day, type, tentative flag and optional branch scope. */
export function HolidayDialog({ open, onOpenChange, calendarId, holiday }: { open: boolean; onOpenChange: (o: boolean) => void; calendarId: string; holiday: HolidayDto | null }) {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const branches = useBranchOptions();
  const { createHoliday, updateHoliday } = useHolidayMutations();
  const form = useForm<HolidayValues, unknown, HolidayInput>({
    resolver: zodResolver(holidayInputSchema),
    defaultValues: holiday ? { calendarId: holiday.calendarId, name: holiday.name, nameAr: holiday.nameAr ?? undefined, date: holiday.date, endDate: holiday.endDate, isHalfDay: holiday.isHalfDay, type: holiday.type as HolidayValues['type'], branchIds: holiday.branchIds, isTentative: holiday.isTentative }
      : { calendarId, name: '', date: todayIso(tz), endDate: null, isHalfDay: false, type: 'PUBLIC', branchIds: null, isTentative: false },
  });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const branchIds = useWatch({ control, name: 'branchIds' });
  const allBranches = branchIds === null || branchIds === undefined;
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      if (holiday) { await updateHoliday.mutateAsync({ id: holiday.id, input: v }); toast.success(t('holidays.updated')); }
      else { await createHoliday.mutateAsync(v); toast.success(t('holidays.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{holiday ? t('holidays.edit') : t('holidays.add')}</DialogTitle><DialogDescription>{t('holidays.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.name')} htmlFor="hd-name" required error={errors.name?.message}><Input id="hd-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={t('fields.nameAr')} htmlFor="hd-nameAr" optional error={errors.nameAr?.message}><Input id="hd-nameAr" dir="rtl" {...register('nameAr', { setValueAs: blankToUndefined })} /></FormField>
            <FormField label={tc('common.date')} htmlFor="hd-date" required error={errors.date?.message}><Input id="hd-date" type="date" dir="ltr" {...register('date')} aria-invalid={!!errors.date} /></FormField>
            <FormField label={t('holidays.endDate')} htmlFor="hd-end" optional hint={t('holidays.endDateHint')} error={errors.endDate?.message}><Input id="hd-end" type="date" dir="ltr" {...register('endDate', { setValueAs: (v: unknown) => (v === '' ? null : v) })} /></FormField>
            <FormField label={t('holidays.type')} htmlFor="hd-type" error={errors.type?.message}>
              <Controller control={control} name="type" render={({ field }) => (
                <Select value={field.value ?? 'PUBLIC'} onValueChange={field.onChange}><SelectTrigger id="hd-type"><SelectValue /></SelectTrigger><SelectContent>{HOLIDAY_TYPES.map((h) => <SelectItem key={h} value={h}>{t(`holidays.types.${h}`)}</SelectItem>)}</SelectContent></Select>
              )} />
            </FormField>
            <div className="space-y-2 sm:pt-6">
              <Controller control={control} name="isHalfDay" render={({ field }) => <label className="flex items-center gap-2 text-sm"><Switch checked={!!field.value} onCheckedChange={field.onChange} aria-label={t('holidays.halfDay')} /> {t('holidays.halfDay')}</label>} />
              <Controller control={control} name="isTentative" render={({ field }) => <label className="flex items-center gap-2 text-sm"><Switch checked={!!field.value} onCheckedChange={field.onChange} aria-label={t('holidays.tentative')} /> {t('holidays.tentative')} <span className="text-xs text-muted-foreground">{t('holidays.tentativeHint')}</span></label>} />
            </div>
          </div>
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3"><div><Label htmlFor="hd-all">{t('holidays.allBranches')}</Label><p className="text-xs text-muted-foreground">{t('holidays.branchScopeHint')}</p></div><Switch id="hd-all" checked={allBranches} onCheckedChange={(on) => setValue('branchIds', on ? null : [], { shouldDirty: true })} /></div>
            {!allBranches ? (
              <Controller control={control} name="branchIds" render={({ field }) => {
                const ids = field.value ?? [];
                return (
                  <div className="space-y-2">
                    <Combobox id="hd-branches" value={null} onChange={(v) => v && !ids.includes(v) && field.onChange([...ids, v])} options={branches.options.filter((o) => !ids.includes(o.value))} loading={branches.isLoading} placeholder={t('holidays.addBranch')} />
                    <div className="flex flex-wrap gap-1.5">{ids.map((id) => <Badge key={id} variant="secondary" className="gap-1 pe-1">{branches.byId.get(id)?.name ?? id.slice(0, 8)}<button type="button" className="rounded-full px-1 hover:bg-foreground/10" aria-label={tc('common.delete')} onClick={() => field.onChange(ids.filter((x) => x !== id))}>×</button></Badge>)}</div>
                    {typeof errors.branchIds?.message === 'string' ? <p className="text-xs text-destructive" role="alert">{errors.branchIds.message}</p> : null}
                  </div>
                );
              }} />
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{holiday ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
