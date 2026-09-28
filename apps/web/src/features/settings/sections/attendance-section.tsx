import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { organizationSettingsSchema, type OrganizationSettings } from '@flowza/contracts';
import { FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgId } from '@/features/me/use-me';
import { toNumber } from '@/features/organization/form-utils';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';

/**
 * Settings → Attendance: the organisation-wide attendance policy (`organization_settings.attendance`). Detailed
 * thresholds (grace, late / half-day limits, rounding, overtime, missing-punch behaviour) live in effective-dated rule
 * sets; this form carries the switches around them: processing defaults, self-service check-in, missed punches and the
 * day close, work on non-working days, unexcused days and their pay effect, attendance notes and the statistics targets.
 * The whole group is PUT in one go and validated with the shared contract schema.
 */
const schema = organizationSettingsSchema.shape.attendance.unwrap();
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;
type TimeWindow = { start: string; end: string };

const PAY_EFFECTS = [{ value: '0', key: 'none' }, { value: '0.5', key: 'half' }, { value: '1', key: 'full' }] as const;

function useShiftOptions() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'shifts', { pageSize: 200 }), queryFn: async () => { const r = await api.get<PageEnvelope<{ id: string; name: string; code: string }> | Envelope<{ id: string; name: string; code: string }[]>>(`/orgs/${orgId}/shifts`, { pageSize: 200, status: 'active' }); return Array.isArray(r.data) ? r.data : []; }, retry: false });
}

/** The first message of a (possibly nested / array) react-hook-form error, for fields edited as one control. */
function firstError(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const message = (e as { message?: unknown }).message;
  if (typeof message === 'string' && message !== '') return message;
  for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
    if (k === 'ref' || k === 'type' || k === 'types') continue;
    const m = firstError(v);
    if (m) return m;
  }
  return undefined;
}

/** A list of short tokens (IP / CIDR, leave-type codes) typed as free text; the text stays local so a separator never moves the cursor. */
function TokenListInput({ id, value, onChange, disabled, invalid, multiline, placeholder }: { id: string; value: readonly string[] | undefined; onChange: (v: string[]) => void; disabled?: boolean; invalid?: boolean; multiline?: boolean; placeholder?: string }) {
  const [text, setText] = useState(() => (value ?? []).join(multiline ? '\n' : ', '));
  const update = (raw: string) => { setText(raw); onChange(raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)); };
  return multiline
    ? <Textarea id={id} dir="ltr" rows={3} className="font-mono text-xs" value={text} onChange={(e) => update(e.target.value)} disabled={disabled} aria-invalid={invalid} placeholder={placeholder} />
    : <Input id={id} dir="ltr" value={text} onChange={(e) => update(e.target.value)} disabled={disabled} aria-invalid={invalid} placeholder={placeholder} />;
}

/** A local-time window: both empty = any time (null); otherwise both ends are required. */
function TimeWindowInput({ id, value, onChange, disabled, invalid, startLabel, endLabel }: { id: string; value: TimeWindow | null | undefined; onChange: (v: TimeWindow | null) => void; disabled?: boolean; invalid?: boolean; startLabel: string; endLabel: string }) {
  const [start, setStart] = useState(value?.start ?? '');
  const [end, setEnd] = useState(value?.end ?? '');
  const commit = (s: string, e: string) => { setStart(s); setEnd(e); onChange(s === '' && e === '' ? null : { start: s, end: e }); };
  return (
    <div className="flex items-center gap-2">
      <Input id={id} type="time" dir="ltr" className="tnum" aria-label={startLabel} value={start} onChange={(ev) => commit(ev.target.value, end)} disabled={disabled} aria-invalid={invalid} />
      <span aria-hidden className="text-muted-foreground">–</span>
      <Input id={`${id}-end`} type="time" dir="ltr" className="tnum" aria-label={endLabel} value={end} onChange={(ev) => commit(start, ev.target.value)} disabled={disabled} aria-invalid={invalid} />
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t pt-4">
      <div><h3 className="text-sm font-semibold">{title}</h3>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>
      {children}
    </section>
  );
}

export default function AttendanceSection() {
  const q = useSettingsGroup('attendance');
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return <AttendanceForm key={JSON.stringify(q.data)} initial={q.data} />;
}

function AttendanceForm({ initial }: { initial: OrganizationSettings['attendance'] }) {
  const { t } = useTranslation('settings');
  const readOnly = !useCan()('organization.manage');
  const { putGroup } = useSettingsMutations();
  const shifts = useShiftOptions();
  const form = useForm<Values, unknown, Output>({ resolver: zodResolver(schema), defaultValues: initial, disabled: readOnly });
  const { register, control, formState: { errors, isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => { try { await putGroup.mutateAsync({ group: 'attendance', value: values }); toast.success(t('saved')); form.reset(values); } catch (e) { toastError(e); } });
  const ss = errors.selfService; const mp = errors.missedPunch; const ux = errors.unexcused; const st = errors.stats;
  const switchRow = (name: 'selfService.webCheckIn' | 'selfService.mobileCheckIn' | 'selfService.allowSelfieCheckIn' | 'selfService.regularisation' | 'missedPunch.detectionEnabled' | 'unexcused.autoDeductEnabled' | 'notes.requireReasonForLate' | 'notes.requireReasonForAbsent', id: string, label: string, hint?: string) => (
    <Controller control={control} name={name} render={({ field }) => <SwitchRow id={id} label={label} hint={hint} control={<Switch id={id} checked={!!field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
  );
  const payEffectSelect = (name: 'unexcused.payEffectAbsent' | 'unexcused.payEffectLate' | 'unexcused.payEffectMissingPunch', id: string, label: string) => (
    <FormField label={label} htmlFor={id}>
      <Controller control={control} name={name} render={({ field }) => (
        <Select value={String(field.value ?? 0)} onValueChange={(v) => field.onChange(Number(v))} disabled={readOnly}>
          <SelectTrigger id={id}><SelectValue /></SelectTrigger>
          <SelectContent>{PAY_EFFECTS.map((o) => <SelectItem key={o.value} value={o.value}>{t(`attendance.unexcused.payEffect.${o.key}`)}</SelectItem>)}</SelectContent>
        </Select>
      )} />
    </FormField>
  );
  return (
    <SettingsSection title={t('attendance.title')} description={t('attendance.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('attendance.defaultShift')} htmlFor="att-shift" optional hint={shifts.isError ? t('attendance.shiftsUnavailable') : t('attendance.defaultShiftHint')} error={errors.defaultShiftId?.message}>
          <Controller control={control} name="defaultShiftId" render={({ field }) => <Combobox id="att-shift" value={field.value ?? null} onChange={(v) => field.onChange(v)} options={(shifts.data ?? []).map((s) => ({ value: s.id, label: s.name, description: s.code }))} loading={shifts.isLoading} clearable disabled={readOnly || shifts.isError} placeholder={t('attendance.noDefaultShift')} />} />
        </FormField>
        <FormField label={t('attendance.processingDelay')} htmlFor="att-delay" hint={t('attendance.processingDelayHint')} error={errors.processingDelaySeconds?.message}>
          <Input id="att-delay" type="number" min={0} max={3600} dir="ltr" className="tnum" {...register('processingDelaySeconds', { setValueAs: toNumber })} aria-invalid={!!errors.processingDelaySeconds} />
        </FormField>
        <FormField label={t('attendance.payrollPeriod')} htmlFor="att-period" error={errors.payrollPeriod?.message}>
          <Controller control={control} name="payrollPeriod" render={({ field }) => (
            <Select value={field.value ?? 'calendar_month'} onValueChange={field.onChange} disabled={readOnly}><SelectTrigger id="att-period"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="calendar_month">{t('attendance.calendarMonth')}</SelectItem><SelectItem value="custom_cutoff">{t('attendance.customCutoff')}</SelectItem></SelectContent></Select>
          )} />
        </FormField>
        <FormField label={t('attendance.cutoffDay')} htmlFor="att-cutoff" hint={t('attendance.cutoffDayHint')} error={errors.payrollCutoffDay?.message}>
          <Input id="att-cutoff" type="number" min={1} max={28} dir="ltr" className="tnum" {...register('payrollCutoffDay', { setValueAs: toNumber })} aria-invalid={!!errors.payrollCutoffDay} />
        </FormField>
      </div>
      <Controller control={control} name="allowSelfServiceCorrections" render={({ field }) => <SwitchRow id="att-self" label={t('attendance.selfService')} hint={t('attendance.selfServiceHint')} control={<Switch id="att-self" checked={!!field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />} />

      <Group title={t('attendance.selfServiceCheckIn.title')} hint={t('attendance.selfServiceCheckIn.hint')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {switchRow('selfService.webCheckIn', 'att-ss-web', t('attendance.selfServiceCheckIn.web'))}
          {switchRow('selfService.mobileCheckIn', 'att-ss-mobile', t('attendance.selfServiceCheckIn.mobile'))}
          {switchRow('selfService.allowSelfieCheckIn', 'att-ss-selfie', t('attendance.selfServiceCheckIn.selfie'))}
          {switchRow('selfService.regularisation', 'att-ss-reg', t('attendance.selfServiceCheckIn.regularisation'), t('attendance.selfServiceCheckIn.regularisationHint'))}
        </div>
        {/* review P2-8: the web / mobile switches judge the channel the app declares — a product switch, not a control */}
        <p className="text-xs text-muted-foreground" data-testid="att-ss-channel-note">{t('attendance.selfServiceCheckIn.channelNote')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('attendance.selfServiceCheckIn.geofence')} htmlFor="att-ss-geo" hint={t('attendance.selfServiceCheckIn.geofenceHint')}>
            <Controller control={control} name="selfService.requireGeofence" render={({ field }) => (
              <Select value={field.value ?? 'flag'} onValueChange={field.onChange} disabled={readOnly}><SelectTrigger id="att-ss-geo"><SelectValue /></SelectTrigger><SelectContent>{(['off', 'flag', 'block'] as const).map((v) => <SelectItem key={v} value={v}>{t(`attendance.selfServiceCheckIn.geofenceOptions.${v}`)}</SelectItem>)}</SelectContent></Select>
            )} />
          </FormField>
          <FormField label={t('attendance.selfServiceCheckIn.outOfWindow')} htmlFor="att-ss-oow" hint={t('attendance.selfServiceCheckIn.outOfWindowHint')}>
            <Controller control={control} name="selfService.outOfWindowAction" render={({ field }) => (
              <Select value={field.value ?? 'flag'} onValueChange={field.onChange} disabled={readOnly}><SelectTrigger id="att-ss-oow"><SelectValue /></SelectTrigger><SelectContent>{(['accept', 'flag', 'reject'] as const).map((v) => <SelectItem key={v} value={v}>{t(`attendance.selfServiceCheckIn.outOfWindowOptions.${v}`)}</SelectItem>)}</SelectContent></Select>
            )} />
          </FormField>
          <FormField label={t('attendance.selfServiceCheckIn.checkInWindow')} htmlFor="att-ss-in" hint={t('attendance.selfServiceCheckIn.windowHint')} error={firstError(ss?.checkInWindow)}>
            <Controller control={control} name="selfService.checkInWindow" render={({ field }) => <TimeWindowInput id="att-ss-in" value={field.value} onChange={field.onChange} disabled={readOnly} invalid={!!ss?.checkInWindow} startLabel={t('attendance.selfServiceCheckIn.checkInFrom')} endLabel={t('attendance.selfServiceCheckIn.checkInTo')} />} />
          </FormField>
          <FormField label={t('attendance.selfServiceCheckIn.checkOutWindow')} htmlFor="att-ss-out" hint={t('attendance.selfServiceCheckIn.windowHint')} error={firstError(ss?.checkOutWindow)}>
            <Controller control={control} name="selfService.checkOutWindow" render={({ field }) => <TimeWindowInput id="att-ss-out" value={field.value} onChange={field.onChange} disabled={readOnly} invalid={!!ss?.checkOutWindow} startLabel={t('attendance.selfServiceCheckIn.checkOutFrom')} endLabel={t('attendance.selfServiceCheckIn.checkOutTo')} />} />
          </FormField>
          <FormField label={t('attendance.selfServiceCheckIn.ipAllowList')} htmlFor="att-ss-ip" optional hint={t('attendance.selfServiceCheckIn.ipAllowListHint')} error={firstError(ss?.ipAllowList)}>
            <Controller control={control} name="selfService.ipAllowList" render={({ field }) => <TokenListInput id="att-ss-ip" multiline value={field.value} onChange={field.onChange} disabled={readOnly} invalid={!!ss?.ipAllowList} placeholder="10.0.0.0/8" />} />
          </FormField>
          <FormField label={t('attendance.selfServiceCheckIn.duplicateSeconds')} htmlFor="att-ss-dup" hint={t('attendance.selfServiceCheckIn.duplicateSecondsHint')} error={ss?.duplicatePunchSeconds?.message}>
            <Input id="att-ss-dup" type="number" min={0} max={3600} dir="ltr" className="tnum" {...register('selfService.duplicatePunchSeconds', { setValueAs: toNumber })} aria-invalid={!!ss?.duplicatePunchSeconds} />
          </FormField>
        </div>
      </Group>

      <Group title={t('attendance.missedPunch.title')} hint={t('attendance.missedPunch.hint')}>
        {switchRow('missedPunch.detectionEnabled', 'att-mp-detect', t('attendance.missedPunch.detection'), t('attendance.missedPunch.detectionHint'))}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('attendance.missedPunch.graceDays')} htmlFor="att-mp-grace" hint={t('attendance.missedPunch.graceDaysHint')} error={mp?.dayCloseGraceDays?.message}>
            <Input id="att-mp-grace" type="number" min={0} max={7} dir="ltr" className="tnum" {...register('missedPunch.dayCloseGraceDays', { setValueAs: toNumber })} aria-invalid={!!mp?.dayCloseGraceDays} />
          </FormField>
          <FormField label={t('attendance.missedPunch.splitTime')} htmlFor="att-mp-split" hint={t('attendance.missedPunch.splitTimeHint')} error={mp?.singlePunchSplitTime?.message}>
            <Input id="att-mp-split" type="time" dir="ltr" className="tnum" {...register('missedPunch.singlePunchSplitTime')} aria-invalid={!!mp?.singlePunchSplitTime} />
          </FormField>
        </div>
      </Group>

      <Group title={t('attendance.nonWorkingDay.title')} hint={t('attendance.nonWorkingDay.hint')}>
        <FormField label={t('attendance.nonWorkingDay.action')} htmlFor="att-nwd" className="sm:max-w-md">
          <Controller control={control} name="nonWorkingDay.action" render={({ field }) => (
            <Select value={field.value ?? 'record'} onValueChange={field.onChange} disabled={readOnly}><SelectTrigger id="att-nwd"><SelectValue /></SelectTrigger><SelectContent>{(['record', 'overtime', 'ignore'] as const).map((v) => <SelectItem key={v} value={v}>{t(`attendance.nonWorkingDay.options.${v}`)}</SelectItem>)}</SelectContent></Select>
          )} />
        </FormField>
      </Group>

      <Group title={t('attendance.unexcused.title')} hint={t('attendance.unexcused.hint')}>
        {switchRow('unexcused.autoDeductEnabled', 'att-ux-auto', t('attendance.unexcused.autoDeduct'), t('attendance.unexcused.autoDeductHint'))}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('attendance.unexcused.graceDays')} htmlFor="att-ux-grace" hint={t('attendance.unexcused.graceDaysHint')} error={ux?.graceDays?.message}>
            <Input id="att-ux-grace" type="number" min={0} max={30} dir="ltr" className="tnum" {...register('unexcused.graceDays', { setValueAs: toNumber })} aria-invalid={!!ux?.graceDays} />
          </FormField>
          <div aria-hidden className="hidden sm:block" />
          {payEffectSelect('unexcused.payEffectAbsent', 'att-ux-absent', t('attendance.unexcused.payEffectAbsent'))}
          {payEffectSelect('unexcused.payEffectLate', 'att-ux-late', t('attendance.unexcused.payEffectLate'))}
          {payEffectSelect('unexcused.payEffectMissingPunch', 'att-ux-missing', t('attendance.unexcused.payEffectMissingPunch'))}
          <div aria-hidden className="hidden sm:block" />
          <FormField label={t('attendance.unexcused.priority')} htmlFor="att-ux-priority" hint={t('attendance.unexcused.priorityHint')} error={firstError(ux?.leaveTypePriority)}>
            <Controller control={control} name="unexcused.leaveTypePriority" render={({ field }) => <TokenListInput id="att-ux-priority" value={field.value} onChange={field.onChange} disabled={readOnly} invalid={!!ux?.leaveTypePriority} placeholder="AL, CL" />} />
          </FormField>
          <FormField label={t('attendance.unexcused.exclude')} htmlFor="att-ux-exclude" hint={t('attendance.unexcused.excludeHint')} error={firstError(ux?.excludeLeaveTypeCodes)}>
            <Controller control={control} name="unexcused.excludeLeaveTypeCodes" render={({ field }) => <TokenListInput id="att-ux-exclude" value={field.value} onChange={field.onChange} disabled={readOnly} invalid={!!ux?.excludeLeaveTypeCodes} placeholder="SL, ML" />} />
          </FormField>
        </div>
      </Group>

      <Group title={t('attendance.notes.title')} hint={t('attendance.notes.hint')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {switchRow('notes.requireReasonForLate', 'att-nt-late', t('attendance.notes.requireLate'))}
          {switchRow('notes.requireReasonForAbsent', 'att-nt-absent', t('attendance.notes.requireAbsent'))}
        </div>
      </Group>

      <Group title={t('attendance.stats.title')} hint={t('attendance.stats.hint')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('attendance.stats.target')} htmlFor="att-st-target" error={st?.attendanceTargetPct?.message}>
            <Input id="att-st-target" type="number" min={0} max={100} step="any" dir="ltr" className="tnum" {...register('stats.attendanceTargetPct', { setValueAs: toNumber })} aria-invalid={!!st?.attendanceTargetPct} />
          </FormField>
          <FormField label={t('attendance.stats.fullDayHours')} htmlFor="att-st-hours" error={st?.fullDayHours?.message}>
            <Input id="att-st-hours" type="number" min={1} max={24} step="any" dir="ltr" className="tnum" {...register('stats.fullDayHours', { setValueAs: toNumber })} aria-invalid={!!st?.fullDayHours} />
          </FormField>
        </div>
      </Group>
    </SettingsSection>
  );
}
