import { useMutation } from '@tanstack/react-query';
import { Controller, useWatch, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { organizationSettingsSchema } from '@flowza/contracts';
import { Button, Checkbox, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from '@/components/ui';
import { api, type Envelope } from '@/lib/api-client';
import { toast, toastError } from '@/lib/toast';
import { useOrgId } from '@/features/me/use-me';
import { toNumber } from '@/features/organization/form-utils';
import { SwitchRow } from '../components/settings-section';

/** The notifications group's form schema (notifications-section.tsx validates with it). */
type Schema = ReturnType<typeof organizationSettingsSchema.shape.notifications.unwrap>;
type Values = z.input<Schema>;
type Output = z.output<Schema>;

type AlertGroup = 'lateArrivalAlert' | 'earlyDepartureAlert';
type SwitchName = `${AlertGroup | 'absenceAlert'}.${'enabled' | 'notifyEmployee' | 'notifyManager'}` | 'absenceReminder' | 'missingCheckInReminder' | 'missingCheckInNotifyManager' | 'appreciation.enabled';
const CRITERIA = ['noLate', 'noEarlyDeparture', 'noAbsence', 'noMissingPunch', 'noUnexcused'] as const;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

interface Props {
  control: Control<Values, unknown, Output>;
  register: UseFormRegister<Values>;
  errors: FieldErrors<Values>;
  readOnly: boolean;
  /** The appreciation is switched on in the SAVED settings (what "Send now" runs with). */
  appreciationSaved: boolean;
  dirty: boolean;
}

function Region({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 border-t pt-4">
      <div><h3 id={`${id}-title`} className="text-sm font-semibold">{title}</h3>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>
      {children}
    </section>
  );
}

/**
 * Settings → Notifications → Attendance alerts: late arrivals and early departures (who is told, from how many minutes),
 * absence notices and the reminder before the excuse deadline, the missing check-in reminder, and the weekly thank-you
 * message (when, to whom, its text in both languages, a preview and "Send now for last week"). Part of the notifications
 * group's form (one PUT of the whole group); this module imports react-hook-form, so the React Compiler leaves it alone.
 */
export function AttendanceAlertFields({ control, register, errors, readOnly, appreciationSaved, dirty }: Props) {
  const { t } = useTranslation('settings');
  const switchRow = (name: SwitchName, id: string, label: string, hint?: string) => (
    <Controller control={control} name={name} render={({ field }) => <SwitchRow id={id} label={label} hint={hint} control={<Switch id={id} checked={!!field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
  );
  const alertGroup = (group: AlertGroup, key: 'late' | 'early') => {
    const e = errors[group];
    return (
      <Region id={`ntf-${key}`} title={t(`notifications.alerts.${key}.title`)} hint={t(`notifications.alerts.${key}.hint`)}>
        <div className="grid gap-3 sm:grid-cols-3">
          {switchRow(`${group}.enabled`, `ntf-${key}-enabled`, t(`notifications.alerts.${key}.enabled`))}
          {switchRow(`${group}.notifyEmployee`, `ntf-${key}-employee`, t('notifications.alerts.notifyEmployee'))}
          {switchRow(`${group}.notifyManager`, `ntf-${key}-manager`, t('notifications.alerts.notifyManager'))}
        </div>
        <FormField label={t(`notifications.alerts.${key}.minMinutes`)} htmlFor={`ntf-${key}-min`} hint={t(`notifications.alerts.${key}.minMinutesHint`)} error={e?.minMinutes?.message}>
          <Input id={`ntf-${key}-min`} type="number" min={1} max={600} step={1} dir="ltr" className="tnum sm:w-40" {...register(`${group}.minMinutes`, { setValueAs: toNumber })} aria-invalid={!!e?.minMinutes} />
        </FormField>
      </Region>
    );
  };
  const ap = errors.appreciation;
  return (
    <div className="space-y-5" data-testid="attendance-alerts">
      <div className="border-t pt-4">
        <h3 className="text-base font-semibold">{t('notifications.alerts.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('notifications.alerts.hint')}</p>
      </div>
      {alertGroup('lateArrivalAlert', 'late')}
      {alertGroup('earlyDepartureAlert', 'early')}

      <Region id="ntf-absence" title={t('notifications.alerts.absence.title')} hint={t('notifications.alerts.absence.hint')}>
        <div className="grid gap-3 sm:grid-cols-3">
          {switchRow('absenceAlert.enabled', 'ntf-absence-enabled', t('notifications.alerts.absence.enabled'))}
          {switchRow('absenceAlert.notifyEmployee', 'ntf-absence-employee', t('notifications.alerts.notifyEmployee'))}
          {switchRow('absenceAlert.notifyManager', 'ntf-absence-manager', t('notifications.alerts.notifyManager'))}
        </div>
        {switchRow('absenceReminder', 'ntf-absence-reminder', t('notifications.alerts.absence.reminder'), t('notifications.alerts.absence.reminderHint'))}
      </Region>

      <Region id="ntf-checkin" title={t('notifications.alerts.missingCheckIn.title')} hint={t('notifications.alerts.missingCheckIn.hint')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {switchRow('missingCheckInReminder', 'ntf-checkin-enabled', t('notifications.alerts.missingCheckIn.enabled'))}
          {switchRow('missingCheckInNotifyManager', 'ntf-checkin-manager', t('notifications.alerts.missingCheckIn.notifyManager'))}
        </div>
        <FormField label={t('notifications.alerts.missingCheckIn.minutes')} htmlFor="ntf-checkin-minutes" hint={t('notifications.alerts.missingCheckIn.minutesHint')} error={errors.missingCheckInReminderMinutes?.message}>
          <Input id="ntf-checkin-minutes" type="number" min={15} max={240} step={5} dir="ltr" className="tnum sm:w-40" {...register('missingCheckInReminderMinutes', { setValueAs: toNumber })} aria-invalid={!!errors.missingCheckInReminderMinutes} />
        </FormField>
      </Region>

      <Region id="ntf-thanks" title={t('notifications.alerts.appreciation.title')} hint={t('notifications.alerts.appreciation.hint')}>
        {switchRow('appreciation.enabled', 'ntf-thanks-enabled', t('notifications.alerts.appreciation.enabled'))}
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={t('notifications.alerts.appreciation.weekday')} htmlFor="ntf-thanks-weekday">
            <Controller control={control} name="appreciation.weekday" render={({ field }) => (
              <Select value={String(field.value ?? 4)} onValueChange={(v) => field.onChange(Number(v))} disabled={readOnly}>
                <SelectTrigger id="ntf-thanks-weekday"><SelectValue /></SelectTrigger>
                <SelectContent>{WEEKDAYS.map((d) => <SelectItem key={d} value={String(d)}>{t(`notifications.alerts.appreciation.weekdays.${d}`)}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          <FormField label={t('notifications.alerts.appreciation.hour')} htmlFor="ntf-thanks-hour" hint={t('notifications.alerts.appreciation.hourHint')}>
            <Controller control={control} name="appreciation.hour" render={({ field }) => (
              <Select value={String(field.value ?? 14)} onValueChange={(v) => field.onChange(Number(v))} disabled={readOnly}>
                <SelectTrigger id="ntf-thanks-hour" dir="ltr"><SelectValue /></SelectTrigger>
                <SelectContent>{HOURS.map((hr) => <SelectItem key={hr} value={String(hr)}>{`${String(hr).padStart(2, '0')}:00`}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          <FormField label={t('notifications.alerts.appreciation.minWorkedDays')} htmlFor="ntf-thanks-days" hint={t('notifications.alerts.appreciation.minWorkedDaysHint')} error={ap?.minWorkedDays?.message}>
            <Input id="ntf-thanks-days" type="number" min={1} max={7} step={1} dir="ltr" className="tnum" {...register('appreciation.minWorkedDays', { setValueAs: toNumber })} aria-invalid={!!ap?.minWorkedDays} />
          </FormField>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('notifications.alerts.appreciation.criteria')}</legend>
          <p className="text-xs text-muted-foreground">{t('notifications.alerts.appreciation.criteriaHint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {CRITERIA.map((c) => (
              <Controller key={c} control={control} name={`appreciation.criteria.${c}`} render={({ field }) => (
                <label htmlFor={`ntf-thanks-${c}`} className="flex items-center gap-2 text-sm">
                  <Checkbox id={`ntf-thanks-${c}`} checked={!!field.value} onCheckedChange={(v) => field.onChange(v === true)} disabled={readOnly} />
                  {t(`notifications.alerts.appreciation.${c}`)}
                </label>
              )} />
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('notifications.alerts.appreciation.messageEn')} htmlFor="ntf-thanks-en" hint={t('notifications.alerts.appreciation.messageHint')} error={ap?.messageEn?.message}>
            <Textarea id="ntf-thanks-en" dir="ltr" lang="en" rows={3} maxLength={500} {...register('appreciation.messageEn')} aria-invalid={!!ap?.messageEn} />
          </FormField>
          <FormField label={t('notifications.alerts.appreciation.messageAr')} htmlFor="ntf-thanks-ar" hint={t('notifications.alerts.appreciation.messageHint')} error={ap?.messageAr?.message}>
            <Textarea id="ntf-thanks-ar" dir="rtl" lang="ar" rows={3} maxLength={500} {...register('appreciation.messageAr')} aria-invalid={!!ap?.messageAr} />
          </FormField>
        </div>
        <AppreciationPreview control={control} />
        {readOnly ? null : <SendNow enabled={appreciationSaved} dirty={dirty} />}
      </Region>
    </div>
  );
}

/** What an employee receives, in both languages, from the texts being edited. */
function AppreciationPreview({ control }: { control: Control<Values, unknown, Output> }) {
  const { t } = useTranslation('settings');
  const en = useWatch({ control, name: 'appreciation.messageEn' });
  const ar = useWatch({ control, name: 'appreciation.messageAr' });
  return (
    <div className="space-y-2" data-testid="appreciation-preview">
      <p className="text-sm font-medium">{t('notifications.alerts.appreciation.preview')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border bg-muted/40 p-3" dir="ltr" lang="en">
          <p className="text-sm font-semibold">{t('notifications.alerts.appreciation.previewTitleEn')}</p>
          <p className="whitespace-pre-line text-sm text-muted-foreground">{en?.trim() || t('notifications.alerts.appreciation.previewEmpty')}</p>
        </div>
        <div className="rounded-md border bg-muted/40 p-3" dir="rtl" lang="ar">
          <p className="text-sm font-semibold">{t('notifications.alerts.appreciation.previewTitleAr')}</p>
          <p className="whitespace-pre-line text-sm text-muted-foreground">{ar?.trim() || t('notifications.alerts.appreciation.previewEmpty')}</p>
        </div>
      </div>
    </div>
  );
}

/** "Send now for last week": queues the worker's appreciation run (a queue job — no job page to link to). */
function SendNow({ enabled, dirty }: { enabled: boolean; dirty: boolean }) {
  const { t } = useTranslation('settings');
  const orgId = useOrgId();
  const send = useMutation({ mutationFn: async () => (await api.post<Envelope<{ jobId: string; status: 'QUEUED' }>>(`/orgs/${orgId}/notifications/appreciation/send`)).data });
  const blocked = dirty ? t('notifications.alerts.appreciation.sendNowUnsaved') : !enabled ? t('notifications.alerts.appreciation.sendNowOff') : null;
  const onClick = async () => {
    try { await send.mutateAsync(); toast.success(t('notifications.alerts.appreciation.sendNowQueued')); } catch (e) { toastError(e); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" onClick={() => void onClick()} loading={send.isPending} disabled={blocked !== null}>{t('notifications.alerts.appreciation.sendNow')}</Button>
      <p className="text-xs text-muted-foreground">{blocked ?? t('notifications.alerts.appreciation.sendNowHint')}</p>
    </div>
  );
}
