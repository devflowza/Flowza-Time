import { useMemo } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { CalendarClock } from 'lucide-react';
import {
  createReportScheduleSchema, SCHEDULABLE_REPORT_TYPES, WEEK_PARAMETER_REPORT_TYPES,
  type CreateReportScheduleInput, type ReportPeriodRule, type ReportScheduleCadence, type ReportScheduleDto, type ReportType,
} from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useActiveMembership } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { useLeaveTypes } from '@/features/leave/api';
import { EmployeeMultiSelect } from '@/features/attendance/components/employee-multi-select';
import '../schedules-i18n';
import { useReportTypes, type ReportTypeDef } from '../api';
import { useScheduleMutations } from '../schedules-api';
import { allowedPeriodRules } from '../schedule-utils';
import { RecipientsPicker } from './recipients-picker';
import { ChannelsField } from './share-report-dialog';

type FormValues = z.input<typeof createReportScheduleSchema>;
const PERIOD_PARAMS = new Set(['from', 'to', 'month']);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

function defaultsFor(def: ReportTypeDef | undefined, firstDay: number): Partial<FormValues> {
  if (!def) return {};
  const week = WEEK_PARAMETER_REPORT_TYPES.includes(def.key);
  const cadence: ReportScheduleCadence = week ? 'weekly' : 'monthly';
  const format = def.defaultFormat && def.formats.includes(def.defaultFormat) ? def.defaultFormat : def.formats[0];
  return { reportType: def.key, format, cadence, runDay: week ? firstDay : 1, periodRule: allowedPeriodRules(cadence, def.key)[0] ?? 'previous_month', customFromDay: null, customToDay: null };
}

/**
 * Create / edit a report schedule (HR portal Prompt 6a): report type + filters, cadence (monthly on a day 1–28 or weekly on a
 * weekday) at a local time, the period each run covers, recipients and channels. The worker runs it every due occurrence —
 * each recipient receives a copy generated under their own access scope.
 */
export function ScheduleDialog({ schedule, onClose }: { schedule: ReportScheduleDto | null; onClose: () => void }) {
  const { t } = useTranslation('reportSchedules');
  const { t: tr } = useTranslation('reports');
  const { t: tc } = useTranslation();
  const firstDay = useActiveMembership()?.settings.general?.firstDayOfWeek ?? 0;
  const types = useReportTypes();
  const { create, update } = useScheduleMutations();
  const choices = useMemo(() => (types.data ?? []).filter((d) => SCHEDULABLE_REPORT_TYPES.includes(d.key) && d.allowed !== false), [types.data]);
  const initial: FormValues = schedule
    ? { name: schedule.name, reportType: schedule.reportType, format: schedule.format, filters: schedule.filters, cadence: schedule.cadence, runDay: schedule.runDay, runTime: schedule.runTime.slice(0, 5), periodRule: schedule.periodRule, customFromDay: schedule.customFromDay, customToDay: schedule.customToDay, recipients: schedule.recipients, channels: schedule.channels, isActive: schedule.isActive }
    : { name: '', filters: {}, runTime: '07:00', recipients: { userIds: [], roleKeys: [] }, channels: ['in_app', 'email'], isActive: true, cadence: 'monthly', runDay: 1, periodRule: 'previous_month', reportType: 'monthly_attendance', format: 'pdf' };
  const form = useForm<FormValues, unknown, CreateReportScheduleInput>({ resolver: zodResolver(createReportScheduleSchema), defaultValues: initial });
  const { control, register, setValue, formState: { errors, isSubmitting } } = form;
  const reportType = useWatch({ control, name: 'reportType' }) as ReportType;
  const cadence = useWatch({ control, name: 'cadence' }) as ReportScheduleCadence;
  const periodRule = useWatch({ control, name: 'periodRule' }) as ReportPeriodRule;
  const branchId = useWatch({ control, name: 'filters.branchId' });
  const def = choices.find((d) => d.key === reportType) ?? (types.data ?? []).find((d) => d.key === reportType);
  const params = useMemo(() => new Set([...(def?.requiredParameters ?? []), ...(def?.optionalParameters ?? [])].filter((p) => !PERIOD_PARAMS.has(p))), [def]);
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(branchId || undefined);
  const leaveTypes = useLeaveTypes();
  const rules = allowedPeriodRules(cadence, reportType);
  const fErr = errors.filters as Partial<Record<string, { message?: string }>> | undefined;

  const onType = (key: string) => {
    const next = choices.find((d) => d.key === key);
    const d = defaultsFor(next, firstDay);
    for (const [k, v] of Object.entries(d)) setValue(k as keyof FormValues, v as never, { shouldValidate: false });
    setValue('filters', {});
  };
  const onCadence = (c: ReportScheduleCadence) => {
    setValue('cadence', c);
    setValue('runDay', c === 'weekly' ? firstDay : 1);
    const allowed = allowedPeriodRules(c, reportType);
    if (!allowed.includes(periodRule)) setValue('periodRule', allowed[0] ?? 'previous_month');
  };
  const onSubmit = form.handleSubmit(async (values) => {
    const input: CreateReportScheduleInput = { ...values, customFromDay: values.periodRule === 'custom' ? values.customFromDay : null, customToDay: values.periodRule === 'custom' ? values.customToDay : null, filters: Object.fromEntries(Object.entries(values.filters).filter(([k, v]) => params.has(k) && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))) };
    try {
      if (schedule) await update.mutateAsync({ id: schedule.id, input });
      else await create.mutateAsync(input);
      toast.success(schedule ? t('schedule.saved') : t('schedule.created'));
      onClose();
    } catch (e) { toastError(e); }
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" data-testid="schedule-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarClock className="size-4" /> {schedule ? t('schedule.editTitle') : t('schedule.newTitle')}</DialogTitle>
          <DialogDescription>{t('schedule.subtitle')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate id="schedule-form">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('schedule.name')} htmlFor="sc-name" required error={errors.name ? t('schedule.nameRequired') : undefined}><Input id="sc-name" {...register('name')} placeholder={t('schedule.namePlaceholder')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={tr('request.type')} htmlFor="sc-type" required error={errors.reportType ? t('schedule.typeInvalid') : undefined}>
              <Controller control={control} name="reportType" render={({ field }) => (
                <Select value={field.value} onValueChange={(v) => { field.onChange(v); onType(v); }}>
                  <SelectTrigger id="sc-type" aria-label={tr('request.type')}><SelectValue /></SelectTrigger>
                  <SelectContent>{choices.map((d) => <SelectItem key={d.key} value={d.key}>{tr(`types.${d.key}.name`, { defaultValue: d.name })}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label={tr('request.format')} htmlFor="sc-format" required>
              <Controller control={control} name="format" render={({ field }) => (
                <Select value={field.value ?? def?.formats[0]} onValueChange={field.onChange}>
                  <SelectTrigger id="sc-format" aria-label={tr('request.format')}><SelectValue /></SelectTrigger>
                  <SelectContent>{(def?.formats ?? ['pdf']).map((f) => <SelectItem key={f} value={f}>{tr(`formats.${f}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label={t('schedule.cadence')} htmlFor="sc-cadence" required>
              <Select value={cadence} onValueChange={(v) => onCadence(v as ReportScheduleCadence)}>
                <SelectTrigger id="sc-cadence" aria-label={t('schedule.cadence')}><SelectValue /></SelectTrigger>
                <SelectContent>{(['monthly', 'weekly'] as const).map((c) => <SelectItem key={c} value={c} disabled={allowedPeriodRules(c, reportType).length === 0}>{t(`cadence.${c}`)}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField label={cadence === 'weekly' ? t('schedule.runWeekday') : t('schedule.runDay')} htmlFor="sc-day" required error={errors.runDay ? t('schedule.runDayInvalid') : undefined}>
              <Controller control={control} name="runDay" render={({ field }) => (
                <Select value={String(field.value ?? '')} onValueChange={(v) => field.onChange(Number(v))}>
                  <SelectTrigger id="sc-day" aria-label={cadence === 'weekly' ? t('schedule.runWeekday') : t('schedule.runDay')}><SelectValue /></SelectTrigger>
                  <SelectContent>{cadence === 'weekly'
                    ? WEEKDAYS.map((d) => <SelectItem key={d} value={String(d)}>{fmtDate(`2024-01-${String(7 + d).padStart(2, '0')}`, 'cccc')}</SelectItem>)
                    : MONTH_DAYS.map((d) => <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label={t('schedule.runTime')} htmlFor="sc-time" required hint={t('schedule.runTimeHint')} error={errors.runTime ? t('schedule.runTimeInvalid') : undefined}><Input id="sc-time" type="time" dir="ltr" {...register('runTime')} aria-invalid={!!errors.runTime} /></FormField>
            <FormField label={t('schedule.period')} htmlFor="sc-period" required error={errors.periodRule ? t('schedule.periodInvalid') : undefined}>
              <Controller control={control} name="periodRule" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="sc-period" aria-label={t('schedule.period')}><SelectValue /></SelectTrigger>
                  <SelectContent>{rules.map((r) => <SelectItem key={r} value={r}>{t(`period.${r}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            {periodRule === 'custom' ? (
              <div className="grid grid-cols-2 gap-3">
                <FormField label={t('schedule.customFrom')} htmlFor="sc-cfrom" required error={errors.customFromDay ? t('schedule.customInvalid') : undefined}><Input id="sc-cfrom" type="number" min={1} max={28} dir="ltr" {...register('customFromDay', { setValueAs: (v) => (v === '' || v === null || v === undefined ? null : Number(v)) })} aria-invalid={!!errors.customFromDay} /></FormField>
                <FormField label={t('schedule.customTo')} htmlFor="sc-cto" required><Input id="sc-cto" type="number" min={1} max={28} dir="ltr" {...register('customToDay', { setValueAs: (v) => (v === '' || v === null || v === undefined ? null : Number(v)) })} /></FormField>
              </div>
            ) : null}
          </div>
          {params.size ? (
            <div className="grid gap-4 rounded-md border bg-muted/30 p-3 sm:grid-cols-2">
              <p className="text-xs font-medium text-muted-foreground sm:col-span-2">{t('schedule.filters')}</p>
              {params.has('branchId') ? <FormField label={tc('common.branch')} htmlFor="sc-branch" optional error={fErr?.['branchId']?.message}>
                <Controller control={control} name="filters.branchId" render={({ field }) => <Combobox id="sc-branch" value={field.value ?? null} onChange={(v) => { field.onChange(v ?? undefined); setValue('filters.departmentId', undefined); }} options={branches.options} loading={branches.isLoading} clearable placeholder={tr('request.allBranches')} />} />
              </FormField> : null}
              {params.has('departmentId') ? <FormField label={tc('common.department')} htmlFor="sc-dept" optional>
                <Controller control={control} name="filters.departmentId" render={({ field }) => <Combobox id="sc-dept" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tr('request.allDepartments')} />} />
              </FormField> : null}
              {params.has('leaveTypeCode') ? <FormField label={tr('request.leaveType')} htmlFor="sc-leave" required={def?.requiredParameters.includes('leaveTypeCode')} error={fErr?.['leaveTypeCode']?.message}>
                <Controller control={control} name="filters.leaveTypeCode" render={({ field }) => <Combobox id="sc-leave" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={(leaveTypes.data ?? []).filter((l) => l.status === 'active').map((l) => ({ value: l.code, label: l.name, description: l.code }))} loading={leaveTypes.isLoading} placeholder={tr('request.pickLeaveType')} />} />
              </FormField> : null}
              {params.has('employmentStatus') ? <FormField label={tr('request.employmentStatus')} htmlFor="sc-emp-status" optional>
                <Controller control={control} name="filters.employmentStatus" render={({ field }) => (
                  <Select value={field.value ?? 'active'} onValueChange={field.onChange}>
                    <SelectTrigger id="sc-emp-status"><SelectValue /></SelectTrigger>
                    <SelectContent>{(['active', 'inactive', 'all'] as const).map((v) => <SelectItem key={v} value={v}>{tr(`request.employmentStatuses.${v}`)}</SelectItem>)}</SelectContent>
                  </Select>
                )} />
              </FormField> : null}
              {params.has('scope') ? <FormField label={tr('request.scope')} htmlFor="sc-scope" optional>
                <Controller control={control} name="filters.scope" render={({ field }) => (
                  <Select value={field.value ?? 'attendance'} onValueChange={field.onChange}>
                    <SelectTrigger id="sc-scope"><SelectValue /></SelectTrigger>
                    <SelectContent>{(['attendance', 'all'] as const).map((v) => <SelectItem key={v} value={v}>{tr(`request.scopes.${v}`)}</SelectItem>)}</SelectContent>
                  </Select>
                )} />
              </FormField> : null}
              {params.has('employeeIds') ? <FormField label={tr('request.employees')} htmlFor="sc-emps" className="sm:col-span-2" required={def?.requiredParameters.includes('employeeIds')} optional={!def?.requiredParameters.includes('employeeIds')} error={fErr?.['employeeIds']?.message}>
                <Controller control={control} name="filters.employeeIds" render={({ field }) => <EmployeeMultiSelect id="sc-emps" value={field.value ?? []} onChange={(ids) => field.onChange(ids.length ? ids : undefined)} max={500} />} />
              </FormField> : null}
            </div>
          ) : null}
          <FormField label={t('recipients.label')} htmlFor="sc-recipients" required error={errors.recipients ? t('recipients.required') : undefined}>
            <Controller control={control} name="recipients" render={({ field }) => <RecipientsPicker id="sc-recipients" value={{ userIds: field.value?.userIds ?? [], roleKeys: field.value?.roleKeys ?? [] }} onChange={field.onChange} invalid={!!errors.recipients} />} />
          </FormField>
          <Controller control={control} name="channels" render={({ field }) => <ChannelsField value={field.value ?? []} onChange={field.onChange} error={errors.channels ? t('channels.required') : undefined} />} />
          <Controller control={control} name="isActive" render={({ field }) => <Label className="flex items-center gap-2 text-sm font-normal"><Switch checked={field.value ?? true} onCheckedChange={field.onChange} aria-label={t('schedule.active')} /> {t('schedule.active')}</Label>} />
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="submit" form="schedule-form" loading={isSubmitting}>{schedule ? tc('common.save') : t('schedule.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
