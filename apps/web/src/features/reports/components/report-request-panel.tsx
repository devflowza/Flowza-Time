import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { BarChart3, Lock, Send } from 'lucide-react';
import { createReportRequestSchema, type CreateReportRequest, type ReportFormat } from '@flowza/contracts';
import type { z } from 'zod';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { api, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { blankToUndefined } from '@/features/organization/form-utils';
import { useShiftOptions } from '@/features/schedule/api';
import { EmployeeMultiSelect } from '@/features/attendance/components/employee-multi-select';
import { useReportMutations, useReportTypes, type ReportTypeDef } from '../api';

type FormValues = z.input<typeof createReportRequestSchema>;
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function useDeviceOptions() {
  const orgId = useOrgId();
  const q = useQuery({ queryKey: qk.list(orgId, 'devices', { pageSize: 200 }), queryFn: () => api.get<PageEnvelope<{ id: string; name: string; code: string }>>(`/orgs/${orgId}/devices`, { pageSize: 200 }), staleTime: 60_000 });
  return { options: (q.data?.data ?? []).map((d) => ({ value: d.id, label: d.name, description: d.code })), byId: new Map((q.data?.data ?? []).map((d) => [d.id, d])), isLoading: q.isLoading };
}

/** Parameter form for one report type. Remounted per type (key) so defaults and the type-specific required-parameter refinement reset. */
function ReportForm({ def, onQueued }: { def: ReportTypeDef; onQueued: (id: string) => void }) {
  const { t } = useTranslation('reports');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const { create } = useReportMutations();
  const branches = useBranchOptions();
  const shifts = useShiftOptions(true);
  const devices = useDeviceOptions();
  const params = useMemo(() => new Set([...def.requiredParameters, ...def.optionalParameters]), [def]);
  const required = useMemo(() => new Set(def.requiredParameters), [def]);
  // Same contract schema the API validates, plus the catalogue's required parameters for this report type.
  const schema = useMemo(() => createReportRequestSchema.superRefine((v, ctx) => {
    for (const p of def.requiredParameters) if (isEmpty((v.parameters as Record<string, unknown> | undefined)?.[p])) ctx.addIssue({ code: 'custom', path: ['parameters', p], message: t('request.required') });
    if (v.parameters?.from && v.parameters?.to && v.parameters.to < v.parameters.from) ctx.addIssue({ code: 'custom', path: ['parameters', 'to'], message: t('request.toBeforeFrom') });
  }), [def, t]);
  const today = todayIso(tz);
  const form = useForm<FormValues, unknown, CreateReportRequest>({
    resolver: zodResolver(schema),
    defaultValues: { reportType: def.key, format: def.formats.includes('xlsx') ? 'xlsx' : def.formats[0], parameters: { ...(params.has('from') ? { from: today.slice(0, 8) + '01', to: today } : {}), ...(params.has('month') ? { month: today.slice(0, 7) } : {}), ...(params.has('employeeIds') ? { employeeIds: [] } : {}), ...(params.has('deviceIds') ? { deviceIds: [] } : {}) } },
  });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const branchId = useWatch({ control, name: 'parameters.branchId' });
  const departments = useDepartmentOptions(branchId || undefined);
  const pErr = errors.parameters as Partial<Record<string, { message?: string }>> | undefined;
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const p = Object.fromEntries(Object.entries(values.parameters ?? {}).filter(([, v]) => !isEmpty(v)));
      const res = await create.mutateAsync({ ...values, parameters: p });
      toast.success(t('request.queued'), { description: t('request.queuedHint') });
      onQueued(res.id);
    } catch (e) { toastError(e); }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate data-testid="report-form">
      <div className="grid gap-4 sm:grid-cols-2">
        {params.has('from') ? <>
          <FormField label={tc('common.from')} htmlFor="rp-from" required={required.has('from')} error={pErr?.['from']?.message}><Input id="rp-from" type="date" dir="ltr" {...register('parameters.from', { setValueAs: blankToUndefined })} aria-invalid={!!pErr?.['from']} /></FormField>
          {params.has('to') ? <FormField label={tc('common.to')} htmlFor="rp-to" required={required.has('to')} error={pErr?.['to']?.message}><Input id="rp-to" type="date" dir="ltr" {...register('parameters.to', { setValueAs: blankToUndefined })} aria-invalid={!!pErr?.['to']} /></FormField> : null}
        </> : null}
        {params.has('month') ? <FormField label={t('request.month')} htmlFor="rp-month" required={required.has('month')} error={pErr?.['month']?.message}><Input id="rp-month" type="month" dir="ltr" {...register('parameters.month', { setValueAs: blankToUndefined })} aria-invalid={!!pErr?.['month']} /></FormField> : null}
        {params.has('branchId') ? <FormField label={tc('common.branch')} htmlFor="rp-branch" required={required.has('branchId')} optional={!required.has('branchId')} error={pErr?.['branchId']?.message}>
          <Controller control={control} name="parameters.branchId" render={({ field }) => <Combobox id="rp-branch" value={field.value ?? null} onChange={(v) => { field.onChange(v ?? undefined); form.setValue('parameters.departmentId', undefined); }} options={branches.options} loading={branches.isLoading} clearable placeholder={t('request.allBranches')} aria-invalid={!!pErr?.['branchId']} />} />
        </FormField> : null}
        {params.has('departmentId') ? <FormField label={tc('common.department')} htmlFor="rp-dept" optional error={pErr?.['departmentId']?.message}>
          <Controller control={control} name="parameters.departmentId" render={({ field }) => <Combobox id="rp-dept" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={t('request.allDepartments')} />} />
        </FormField> : null}
        {params.has('shiftId') ? <FormField label={t('request.shift')} htmlFor="rp-shift" optional error={pErr?.['shiftId']?.message}>
          <Controller control={control} name="parameters.shiftId" render={({ field }) => <Combobox id="rp-shift" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={shifts.options} loading={shifts.isLoading} clearable placeholder={t('request.allShifts')} />} />
        </FormField> : null}
        <FormField label={t('request.format')} htmlFor="rp-format" required error={errors.format?.message}>
          <Controller control={control} name="format" render={({ field }) => (
            <Select value={field.value ?? def.formats[0]} onValueChange={field.onChange}>
              <SelectTrigger id="rp-format"><SelectValue /></SelectTrigger>
              <SelectContent>{def.formats.map((f: ReportFormat) => <SelectItem key={f} value={f}>{t(`formats.${f}`)}</SelectItem>)}</SelectContent>
            </Select>
          )} />
        </FormField>
      </div>
      {params.has('employeeIds') ? <FormField label={t('request.employees')} htmlFor="rp-emps" required={required.has('employeeIds')} optional={!required.has('employeeIds')} hint={t('request.employeesHint')} error={pErr?.['employeeIds']?.message}>
        <Controller control={control} name="parameters.employeeIds" render={({ field }) => <EmployeeMultiSelect id="rp-emps" value={field.value ?? []} onChange={field.onChange} max={5000} />} />
      </FormField> : null}
      {params.has('deviceIds') ? <FormField label={t('request.devices')} htmlFor="rp-devices" optional error={pErr?.['deviceIds']?.message}>
        <Controller control={control} name="parameters.deviceIds" render={({ field }) => { const ids = field.value ?? []; return (
          <div className="space-y-2">
            <Combobox id="rp-devices" value={null} onChange={(v) => v && !ids.includes(v) && field.onChange([...ids, v])} options={devices.options.filter((o) => !ids.includes(o.value))} loading={devices.isLoading} placeholder={t('request.addDevice')} />
            <div className="flex flex-wrap gap-1.5">{ids.map((id) => <Badge key={id} variant="secondary" className="gap-1 pe-1">{devices.byId.get(id)?.name ?? id.slice(0, 8)}<button type="button" className="rounded-full px-1 hover:bg-foreground/10" aria-label={tc('common.delete')} onClick={() => field.onChange(ids.filter((x) => x !== id))}>×</button></Badge>)}</div>
          </div>
        ); }} />
      </FormField> : null}
      <FormField label={t('request.reason')} htmlFor="rp-reason" optional hint={t('request.reasonHint')} error={errors.reason?.message}><Input id="rp-reason" {...register('reason', { setValueAs: blankToUndefined })} /></FormField>
      <div className="flex justify-end"><Button type="submit" loading={isSubmitting} disabled={def.allowed === false}><Send /> {t('request.submit')}</Button></div>
    </form>
  );
}

/** Report catalogue (cards) + the parameter form of the selected type. */
export function ReportRequestPanel({ onQueued }: { onQueued: (id: string) => void }) {
  const { t } = useTranslation('reports');
  const types = useReportTypes();
  const [selected, setSelected] = useState<string | null>(null);
  const def = types.data?.find((d) => d.key === selected) ?? null;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 className="size-4" /> {t('request.title')}</CardTitle><CardDescription>{t('request.hint')}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {types.isLoading ? <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
          : types.isError ? <ErrorState error={types.error} onRetry={() => void types.refetch()} />
          : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={t('request.type')}>
              {(types.data ?? []).map((d) => (
                <button key={d.key} type="button" role="radio" aria-checked={selected === d.key} disabled={d.allowed === false} onClick={() => setSelected(d.key)}
                  className={cn('flex flex-col items-start gap-1 rounded-lg border bg-card p-3 text-start transition-colors hover:border-brand-300 disabled:cursor-not-allowed disabled:opacity-60', selected === d.key && 'border-brand-500 ring-1 ring-brand-500')}>
                  <span className="flex w-full items-center gap-2 text-sm font-medium"><span className="truncate">{t(`types.${d.key}.name`, { defaultValue: d.name })}</span>{d.allowed === false ? <Lock className="ms-auto size-3.5 shrink-0 text-muted-foreground" aria-label={t('request.notAllowed')} /> : null}</span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{t(`types.${d.key}.description`, { defaultValue: d.description })}</span>
                  <span className="mt-1 flex flex-wrap gap-1">{d.formats.map((f) => <Badge key={f} variant="outline" className="text-[10px] uppercase">{f}</Badge>)}</span>
                </button>
              ))}
            </div>
          )}
        {def ? <div className="rounded-lg border bg-muted/30 p-4"><h4 className="mb-3 text-sm font-semibold">{t('request.parametersFor', { name: t(`types.${def.key}.name`, { defaultValue: def.name }) })}</h4><ReportForm key={def.key} def={def} onQueued={onQueued} /></div>
          : types.data ? <p className="text-sm text-muted-foreground">{t('request.pickType')}</p> : null}
      </CardContent>
    </Card>
  );
}
