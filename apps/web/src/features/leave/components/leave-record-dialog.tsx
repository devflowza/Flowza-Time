import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { HALF_DAY_PARTS, leaveRecordInputSchema, type LeaveRecordInput, type LeaveWarningDto, type UpdateLeaveRecordInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { blankToUndefined } from '@/features/organization/form-utils';
import { useEmployeeOptions } from '@/features/employees/api';
import { toastJobQueued } from '@/features/employees/job-toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useLeaveMutations, useLeaveTypeOptions } from '../api';
import type { LeaveRecordDto } from '../types';

type FormValues = z.input<typeof leaveRecordInputSchema>;

/** The rules HR's leave broke without being blocked (notice, consecutive cap, balance) — HR decides; the toast says so. */
function warningText(warnings: LeaveWarningDto[] | undefined): string | undefined {
  return warnings?.length ? warnings.map((w) => w.message).join(' ') : undefined;
}

/**
 * Record leave for an employee (leaveRecordInputSchema), or correct an existing record (`record`: only the changed fields are
 * sent). HR's own leave is approved at once unless the type needs approval; notice / consecutive / balance rules only warn
 * HR. Correcting a decided leave is logged as a correction (leave.corrected); an undecided one is re-submitted to its
 * approvers. Past ranges recompute attendance.
 */
export function LeaveRecordDialog({ open, onOpenChange, preset, record }: { open: boolean; onOpenChange: (o: boolean) => void; preset?: Partial<FormValues>; record?: LeaveRecordDto | null }) {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const employees = useEmployeeOptions();
  const types = useLeaveTypeOptions();
  const { createRecord, updateRecord } = useLeaveMutations();
  const today = todayIso(tz);
  const editing = !!record;
  const initial: Partial<FormValues> = record
    ? { employeeId: record.employeeId, leaveTypeId: record.leaveTypeId, startDate: record.startDate, endDate: record.endDate, isHalfDay: record.isHalfDay, halfDayPart: (record.halfDayPart ?? undefined) as FormValues['halfDayPart'], reason: record.reason ?? undefined }
    : { employeeId: '', leaveTypeId: '', startDate: today, endDate: today, isHalfDay: false, ...preset };
  const form = useForm<FormValues, unknown, LeaveRecordInput>({ resolver: zodResolver(leaveRecordInputSchema), defaultValues: initial });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const isHalfDay = useWatch({ control, name: 'isHalfDay' }) ?? false;
  const startDate = useWatch({ control, name: 'startDate' });
  // the employee's own options plus the record's employee when it is not on the first page of the picker
  const employeeOptions = record && !employees.options.some((o) => o.value === record.employeeId) ? [{ value: record.employeeId, label: record.employeeName ?? record.employeeId }, ...employees.options] : employees.options;

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      const halfDayPart = v.isHalfDay ? v.halfDayPart ?? 'FIRST_HALF' : undefined;
      if (record) {
        const patch: UpdateLeaveRecordInput = {};
        if (v.leaveTypeId !== record.leaveTypeId) patch.leaveTypeId = v.leaveTypeId;
        if (v.startDate !== record.startDate) patch.startDate = v.startDate;
        if (v.endDate !== record.endDate) patch.endDate = v.endDate;
        if (!!v.isHalfDay !== record.isHalfDay) patch.isHalfDay = !!v.isHalfDay;
        if ((halfDayPart ?? null) !== (record.halfDayPart ?? null)) patch.halfDayPart = halfDayPart ?? null;
        if ((v.reason ?? null) !== (record.reason ?? null)) patch.reason = v.reason ?? null;
        if (!Object.keys(patch).length) { onOpenChange(false); return; }
        const res = await updateRecord.mutateAsync({ id: record.id, input: patch });
        if (res.recalculationJobId) toastJobQueued(res.recalculationJobId, navigate, t('records.recalcHint'), { to: '/attendance?tab=recalc' });
        else toast.success(t('records.updated'), { description: warningText(res.warnings) ?? (res.status === 'PENDING' ? t('records.resubmitted') : undefined) });
      } else {
        const res = await createRecord.mutateAsync({ ...v, halfDayPart });
        if (res.recalculationJobId) toastJobQueued(res.recalculationJobId, navigate, t('records.recalcHint'), { to: '/attendance?tab=recalc' });
        else toast.success(res.status === 'PENDING' ? t('records.createdPending') : t('records.created'), { description: warningText(res.warnings) });
      }
      onOpenChange(false);
    } catch (e) { toastMutationError(e, navigate); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? t('records.editTitle') : t('records.add')}</DialogTitle><DialogDescription>{editing ? t('records.editHint') : t('records.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('fields.employee')} htmlFor="lr-emp" required error={errors.employeeId?.message}>
              <Controller control={control} name="employeeId" render={({ field }) => <Combobox id="lr-emp" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('fields.selectEmployee')} aria-invalid={!!errors.employeeId} disabled={editing} />} />
            </FormField>
            <FormField label={t('fields.leaveType')} htmlFor="lr-type" required error={errors.leaveTypeId?.message}>
              <Controller control={control} name="leaveTypeId" render={({ field }) => <Combobox id="lr-type" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} options={types.options} loading={types.isLoading} placeholder={t('fields.selectLeaveType')} emptyText={t('types.empty')} aria-invalid={!!errors.leaveTypeId} />} />
            </FormField>
            <FormField label={t('fields.startDate')} htmlFor="lr-start" required error={errors.startDate?.message}>
              <Input id="lr-start" type="date" dir="ltr" {...register('startDate', { onChange: (e) => { if (isHalfDay) setValue('endDate', (e.target as HTMLInputElement).value); } })} aria-invalid={!!errors.startDate} />
            </FormField>
            <FormField label={t('fields.endDate')} htmlFor="lr-end" required error={errors.endDate?.message}>
              <Input id="lr-end" type="date" dir="ltr" min={startDate} disabled={isHalfDay} {...register('endDate')} aria-invalid={!!errors.endDate} />
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller control={control} name="isHalfDay" render={({ field }) => (
              <div className="flex items-center justify-between gap-4 rounded-md border p-3"><div><Label htmlFor="lr-half">{t('fields.halfDay')}</Label><p className="text-xs text-muted-foreground">{t('fields.halfDayHint')}</p></div><Switch id="lr-half" checked={!!field.value} onCheckedChange={(on) => { field.onChange(on); if (on) { setValue('endDate', form.getValues('startDate')); setValue('halfDayPart', 'FIRST_HALF'); } else setValue('halfDayPart', undefined); }} /></div>
            )} />
            {isHalfDay ? (
              <FormField label={t('fields.halfDayPart')} htmlFor="lr-part" error={errors.halfDayPart?.message}>
                <Controller control={control} name="halfDayPart" render={({ field }) => (
                  <Select value={field.value ?? 'FIRST_HALF'} onValueChange={field.onChange}><SelectTrigger id="lr-part"><SelectValue /></SelectTrigger><SelectContent>{HALF_DAY_PARTS.map((p) => <SelectItem key={p} value={p}>{t(`halfDayParts.${p}`)}</SelectItem>)}</SelectContent></Select>
                )} />
              </FormField>
            ) : null}
          </div>
          <FormField label={t('fields.reason')} htmlFor="lr-reason" optional error={errors.reason?.message}><Textarea id="lr-reason" rows={2} {...register('reason', { setValueAs: blankToUndefined })} /></FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{editing ? tc('common.save') : t('records.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
