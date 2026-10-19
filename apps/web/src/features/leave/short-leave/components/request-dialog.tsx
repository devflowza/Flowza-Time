import { useMemo } from 'react';
import { Controller, useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Clock3, Info } from 'lucide-react';
import type { z } from 'zod';
import { selfTimeOffRequestSchema, timeOffRequestInputSchema, type SelfTimeOffDto, type SelfTimeOffRequestInput, type TimeOffRequestInput, type TimeOffTypeDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { useLocalName } from '@/lib/local-name';
import { toast } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeOptions } from '@/features/employees/api';
import { toastJobQueued } from '@/features/employees/job-toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useSelfTimeOffActions, useTimeOffRequestMutations, useTimeOffTypes } from '../api';
import { SL_NS } from '../i18n';
import { checkWindow, fmtDuration, type WindowCheck } from '../model';

type SelfValues = z.input<typeof selfTimeOffRequestSchema>;
type HrValues = z.input<typeof timeOffRequestInputSchema>;
/** The fields both forms share (the HR form adds the employee). */
type WindowValues = Pick<SelfValues, 'date' | 'startTime' | 'endTime' | 'reason'>;

/** The live summary under the window: its length and what the type's limits leave (the API checks every rule again). */
function WindowSummary({ check, type }: { check: WindowCheck; type: TimeOffTypeDto | undefined }) {
  const { t } = useTranslation(SL_NS);
  if (!type) return null;
  const message = check.error === 'window' ? t('portal.errors.window')
    : check.error === 'max' ? t('portal.errors.max', { value: fmtDuration(type.maxMinutesPerRequest) })
    : check.error === 'quota' ? t('portal.errors.quota', { value: fmtDuration(check.remaining) })
    : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/30 p-3 text-sm" data-testid="short-leave-summary">
      <span className="flex items-center gap-1.5"><Clock3 className="size-4 text-muted-foreground" aria-hidden /><span className="tnum font-medium">{fmtDuration(check.minutes)}</span></span>
      {type.countsAsWork ? <span className="text-xs text-muted-foreground">{t('context.work')}</span> : null}
      {message ? <span role="alert" className="text-xs text-destructive">{message}</span> : null}
    </div>
  );
}

/** Date, from, to and the reason — the window of one day (local time of the employee's branch). */
function WindowFields({ form, idPrefix }: { form: UseFormReturn<WindowValues>; idPrefix: string }) {
  const { t } = useTranslation(SL_NS);
  const { register, formState: { errors } } = form;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={t('fields.date')} htmlFor={`${idPrefix}-date`} required error={errors.date ? t('portal.errors.date') : undefined}>
          <Input id={`${idPrefix}-date`} type="date" dir="ltr" className="tnum" {...register('date')} aria-invalid={!!errors.date} />
        </FormField>
        <FormField label={t('fields.startTime')} htmlFor={`${idPrefix}-start`} required error={errors.startTime?.message}>
          <Input id={`${idPrefix}-start`} type="time" step={300} dir="ltr" className="tnum" {...register('startTime')} aria-invalid={!!errors.startTime} />
        </FormField>
        <FormField label={t('fields.endTime')} htmlFor={`${idPrefix}-end`} required error={errors.endTime ? t('portal.errors.window') : undefined}>
          <Input id={`${idPrefix}-end`} type="time" step={300} dir="ltr" className="tnum" {...register('endTime')} aria-invalid={!!errors.endTime} />
        </FormField>
      </div>
      <FormField label={t('fields.reason')} htmlFor={`${idPrefix}-reason`} required error={errors.reason ? t('portal.errors.reason') : undefined}>
        <Textarea id={`${idPrefix}-reason`} rows={3} maxLength={1000} {...register('reason')} aria-invalid={!!errors.reason} dir="auto" />
      </FormField>
    </>
  );
}

/**
 * The employee asks for a short leave (portal): one of the types offered to them, a date, a window and a reason. The form
 * shows the length and refuses what the API would refuse up front — a window that does not run forward, one longer than the
 * type allows, one beyond what this month's quota leaves; the overlaps and the locked periods are the API's to tell.
 */
export function SelfShortLeaveDialog({ open, onOpenChange, data }: { open: boolean; onOpenChange: (o: boolean) => void; data: SelfTimeOffDto | undefined }) {
  const { t } = useTranslation(SL_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const ln = useLocalName();
  const { request } = useSelfTimeOffActions();
  const form = useForm<SelfValues, unknown, SelfTimeOffRequestInput>({
    resolver: zodResolver(selfTimeOffRequestSchema),
    defaultValues: { typeId: data?.types[0]?.id ?? '', date: todayIso(tz), startTime: '', endTime: '', reason: '' },
  });
  const { control, formState: { errors, isSubmitting } } = form;
  const [typeId, date, startTime, endTime] = useWatch({ control, name: ['typeId', 'date', 'startTime', 'endTime'] });
  const type = data?.types.find((x) => x.id === typeId);
  const usage = data?.usage.find((u) => u.typeId === typeId && date?.slice(0, 7) === u.month);
  const check = checkWindow(startTime ?? '', endTime ?? '', { maxMinutesPerRequest: type?.maxMinutesPerRequest ?? null, quotaMinutes: usage ? usage.quotaMinutes : null, usedMinutes: usage?.usedMinutes ?? 0 });
  const onSubmit = form.handleSubmit(async (v) => {
    if (check.error) return;
    try {
      const res = await request.mutateAsync(v);
      toast.success(res.status === 'APPROVED' ? t('portal.approvedAtOnce') : t('portal.submitted'));
      onOpenChange(false);
    } catch (e) { toastMutationError(e, navigate); }
  });
  const types = data?.types ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>{t('portal.requestTitle')}</DialogTitle><DialogDescription>{t('portal.requestHint')}</DialogDescription></DialogHeader>
        {types.length === 0 ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Info className="size-4" aria-hidden />{t('portal.noTypes')}</p> : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <FormField label={t('fields.type')} htmlFor="sl-type" required error={errors.typeId ? t('portal.errors.type') : undefined}>
              <Controller control={control} name="typeId" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="sl-type" aria-invalid={!!errors.typeId}><SelectValue placeholder={t('portal.errors.type')} /></SelectTrigger>
                  <SelectContent>{types.map((x) => <SelectItem key={x.id} value={x.id}>{ln(x.name, x.nameAr)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            <WindowFields form={form as unknown as UseFormReturn<WindowValues>} idPrefix="sl" />
            {usage && usage.quotaMinutes !== null ? <p className="text-xs text-muted-foreground tnum">{t('portal.usage', { used: fmtDuration(usage.usedMinutes), quota: fmtDuration(usage.quotaMinutes) })}</p> : null}
            <WindowSummary check={check} type={type} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
              <Button type="submit" loading={isSubmitting} disabled={!!check.error}>{t('portal.request')}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * HR records a short leave for an employee (leave.manage): approved at once unless a SHORT_LEAVE workflow applies; the length
 * and quota limits only warn here (the toast lists them), HR-only types are available. A past day is recalculated — the toast
 * points at the recalculation (a queue job), never at a sync page.
 */
export function RecordShortLeaveDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation(SL_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const ln = useLocalName();
  const employees = useEmployeeOptions();
  const typesQ = useTimeOffTypes(open);
  const types = useMemo(() => (typesQ.data ?? []).filter((x) => x.status === 'active'), [typesQ.data]);
  const { record } = useTimeOffRequestMutations();
  const form = useForm<HrValues, unknown, TimeOffRequestInput>({
    resolver: zodResolver(timeOffRequestInputSchema),
    defaultValues: { employeeId: '', typeId: '', date: todayIso(tz), startTime: '', endTime: '', reason: '' },
  });
  const { control, formState: { errors, isSubmitting } } = form;
  const [typeId, startTime, endTime] = useWatch({ control, name: ['typeId', 'startTime', 'endTime'] });
  const type = types.find((x) => x.id === typeId);
  const check = checkWindow(startTime ?? '', endTime ?? '', { maxMinutesPerRequest: null, quotaMinutes: null, usedMinutes: 0 });
  const onSubmit = form.handleSubmit(async (v) => {
    if (check.error) return;
    try {
      const res = await record.mutateAsync(v);
      toast.success(res.status === 'APPROVED' ? t('requests.recorded') : t('requests.recordedPending'), res.warnings.length ? { description: `${t('requests.warnings')}: ${res.warnings.map((w) => w.message).join(' ')}` } : undefined);
      if (res.recalculationJobId) toastJobQueued(res.recalculationJobId, navigate, t('requests.recalcHint'), { to: '/attendance?tab=recalc' });
      onOpenChange(false);
    } catch (e) { toastMutationError(e, navigate); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>{t('requests.recordTitle')}</DialogTitle><DialogDescription>{t('requests.recordHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('fields.employee')} htmlFor="slr-employee" required error={errors.employeeId ? tc('common.required') : undefined}>
              <Controller control={control} name="employeeId" render={({ field }) => <Combobox id="slr-employee" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('fields.employee')} />} />
            </FormField>
            <FormField label={t('fields.type')} htmlFor="slr-type" required error={errors.typeId ? t('portal.errors.type') : undefined}>
              <Controller control={control} name="typeId" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="slr-type" aria-invalid={!!errors.typeId}><SelectValue placeholder={t('portal.errors.type')} /></SelectTrigger>
                  <SelectContent>{types.map((x) => <SelectItem key={x.id} value={x.id}>{ln(x.name, x.nameAr)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
          </div>
          <WindowFields form={form as unknown as UseFormReturn<WindowValues>} idPrefix="slr" />
          <WindowSummary check={check} type={type} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting} disabled={!!check.error}>{t('requests.add')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
