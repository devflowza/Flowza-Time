import { useQuery } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { organizationSettingsSchema, type OrganizationSettings } from '@flowza/contracts';
import { FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgId } from '@/features/me/use-me';
import { toNumber } from '@/features/organization/form-utils';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';

const schema = organizationSettingsSchema.shape.attendance.unwrap();
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

function useShiftOptions() {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'shifts', { pageSize: 200 }), queryFn: async () => { const r = await api.get<PageEnvelope<{ id: string; name: string; code: string }> | Envelope<{ id: string; name: string; code: string }[]>>(`/orgs/${orgId}/shifts`, { pageSize: 200, status: 'active' }); return Array.isArray(r.data) ? r.data : []; }, retry: false });
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
    </SettingsSection>
  );
}
