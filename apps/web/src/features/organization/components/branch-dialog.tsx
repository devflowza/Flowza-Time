import { useForm, useWatch, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { branchInputSchema, RECORD_STATUSES, type BranchDto, type BranchInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Label } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useHolidayCalendars, useStructureMutations } from '../api';
import { blankToUndefined, fromSelect, NONE, toOptionalNumber, toSelect } from '../form-utils';
import { TimezoneSelect } from './timezone-select';
import { WeeklyOffToggles } from './weekly-off-toggles';

type FormValues = z.input<typeof branchInputSchema>;

function toDefaults(b: BranchDto | null, orgTimezone: string): FormValues {
  if (!b) return { code: '', name: '', nameAr: undefined, countryCode: 'OM', city: undefined, address: {}, timezone: orgTimezone, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active' };
  return {
    code: b.code, name: b.name, nameAr: b.nameAr ?? undefined, countryCode: b.countryCode, city: b.city ?? undefined, address: b.address ?? {}, timezone: b.timezone,
    latitude: b.latitude ?? undefined, longitude: b.longitude ?? undefined, geofenceRadiusM: b.geofenceRadiusM ?? undefined, contact: b.contact ?? {},
    weeklyOffDays: b.weeklyOffDays, holidayCalendarId: b.holidayCalendarId, status: b.status,
  };
}

export function BranchDialog({ open, onOpenChange, branch, orgTimezone }: { open: boolean; onOpenChange: (o: boolean) => void; branch: BranchDto | null; orgTimezone: string }) {
  const { t } = useTranslation('organization');
  const { t: tc } = useTranslation();
  const { create, update } = useStructureMutations<BranchDto, BranchInput>('branches');
  const calendars = useHolidayCalendars();
  const form = useForm<FormValues, unknown, BranchInput>({ resolver: zodResolver(branchInputSchema), defaultValues: toDefaults(branch, orgTimezone) });
  const { register, control, formState: { errors, isSubmitting }, setValue } = form;
  const weeklyOff = useWatch({ control, name: 'weeklyOffDays' });
  const inheritWeeklyOff = weeklyOff === null || weeklyOff === undefined;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (branch) { await update.mutateAsync({ id: branch.id, input: values }); toast.success(t('branches.updated')); }
      else { await create.mutateAsync(values); toast.success(t('branches.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{branch ? t('branches.edit') : t('branches.add')}</DialogTitle>
          <DialogDescription>{t('branches.dialogHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <section className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.code')} htmlFor="br-code" required error={errors.code?.message}>
              <Input id="br-code" dir="ltr" {...register('code')} aria-invalid={!!errors.code} disabled={!!branch} />
            </FormField>
            <FormField label={tc('common.name')} htmlFor="br-name" required error={errors.name?.message}>
              <Input id="br-name" {...register('name')} aria-invalid={!!errors.name} />
            </FormField>
            <FormField label={t('fields.nameAr')} htmlFor="br-nameAr" optional error={errors.nameAr?.message}>
              <Input id="br-nameAr" dir="rtl" {...register('nameAr', { setValueAs: blankToUndefined })} />
            </FormField>
            <FormField label={t('fields.city')} htmlFor="br-city" optional error={errors.city?.message}>
              <Input id="br-city" {...register('city', { setValueAs: blankToUndefined })} />
            </FormField>
            <FormField label={t('fields.countryCode')} htmlFor="br-country" required error={errors.countryCode?.message} hint={t('fields.countryCodeHint')}>
              <Input id="br-country" dir="ltr" maxLength={2} className="uppercase" {...register('countryCode')} aria-invalid={!!errors.countryCode} />
            </FormField>
            <FormField label={tc('common.timezone')} htmlFor="br-tz" required error={errors.timezone?.message}>
              <Controller control={control} name="timezone" render={({ field }) => <TimezoneSelect id="br-tz" value={field.value} onChange={field.onChange} aria-invalid={!!errors.timezone} />} />
            </FormField>
            <FormField label={t('fields.addressLine1')} htmlFor="br-addr1" optional className="sm:col-span-2">
              <Input id="br-addr1" {...register('address.line1', { setValueAs: blankToUndefined })} />
            </FormField>
          </section>

          <section className="space-y-3">
            <h4 className="text-sm font-semibold">{t('branches.location')}</h4>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label={t('fields.latitude')} htmlFor="br-lat" optional error={errors.latitude?.message}>
                <Input id="br-lat" dir="ltr" type="number" step="any" inputMode="decimal" className="tnum" {...register('latitude', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.latitude} />
              </FormField>
              <FormField label={t('fields.longitude')} htmlFor="br-lng" optional error={errors.longitude?.message}>
                <Input id="br-lng" dir="ltr" type="number" step="any" inputMode="decimal" className="tnum" {...register('longitude', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.longitude} />
              </FormField>
              <FormField label={t('fields.geofence')} htmlFor="br-geo" optional error={errors.geofenceRadiusM?.message} hint={t('fields.geofenceHint')}>
                <Input id="br-geo" dir="ltr" type="number" min={10} max={5000} className="tnum" {...register('geofenceRadiusM', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.geofenceRadiusM} />
              </FormField>
            </div>
          </section>

          <section className="space-y-3">
            <h4 className="text-sm font-semibold">{t('branches.calendar')}</h4>
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <Label htmlFor="br-inherit">{t('branches.inheritWeeklyOff')}</Label>
                <p className="text-xs text-muted-foreground">{t('branches.inheritWeeklyOffHint')}</p>
              </div>
              <Switch id="br-inherit" checked={inheritWeeklyOff} onCheckedChange={(on) => setValue('weeklyOffDays', on ? null : [5, 6], { shouldDirty: true })} />
            </div>
            {!inheritWeeklyOff ? (
              <Controller control={control} name="weeklyOffDays" render={({ field }) => <WeeklyOffToggles value={field.value} onChange={field.onChange} ariaLabel={t('fields.weeklyOffDays')} />} />
            ) : null}
            {calendars.data && calendars.data.length > 0 ? (
              <FormField label={t('fields.holidayCalendar')} htmlFor="br-cal" optional>
                <Controller control={control} name="holidayCalendarId" render={({ field }) => (
                  <Select value={toSelect(field.value)} onValueChange={(v) => field.onChange(fromSelect(v))}>
                    <SelectTrigger id="br-cal"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{tc('common.none')}</SelectItem>
                      {calendars.data.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )} />
              </FormField>
            ) : <p className="text-xs text-muted-foreground">{t('branches.noCalendars')}</p>}
          </section>

          <section className="grid gap-4 sm:grid-cols-3">
            <FormField label={t('fields.contactName')} htmlFor="br-cname" optional>
              <Input id="br-cname" {...register('contact.name', { setValueAs: blankToUndefined })} />
            </FormField>
            <FormField label={t('fields.contactEmail')} htmlFor="br-cemail" optional error={errors.contact?.email?.message}>
              <Input id="br-cemail" type="email" dir="ltr" {...register('contact.email', { setValueAs: blankToUndefined })} aria-invalid={!!errors.contact?.email} />
            </FormField>
            <FormField label={t('fields.contactPhone')} htmlFor="br-cphone" optional error={errors.contact?.phone?.message}>
              <Input id="br-cphone" type="tel" dir="ltr" {...register('contact.phone', { setValueAs: blankToUndefined })} aria-invalid={!!errors.contact?.phone} />
            </FormField>
          </section>

          {branch ? (
            <FormField label={tc('common.status')} htmlFor="br-status">
              <Controller control={control} name="status" render={({ field }) => (
                <Select value={field.value ?? 'active'} onValueChange={field.onChange}>
                  <SelectTrigger id="br-status" className="sm:w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>{RECORD_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{branch ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
