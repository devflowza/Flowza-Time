import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { HALF_DAY_PARTS, leaveRecordInputSchema, type LeaveRecordInput } from '@flowza/contracts';
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

type FormValues = z.input<typeof leaveRecordInputSchema>;

/** Record leave for an employee (leaveRecordInputSchema). Leave is approved on creation; past ranges recompute attendance. */
export function LeaveRecordDialog({ open, onOpenChange, preset }: { open: boolean; onOpenChange: (o: boolean) => void; preset?: Partial<FormValues> }) {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const employees = useEmployeeOptions();
  const types = useLeaveTypeOptions();
  const { createRecord } = useLeaveMutations();
  const today = todayIso(tz);
  const form = useForm<FormValues, unknown, LeaveRecordInput>({ resolver: zodResolver(leaveRecordInputSchema), defaultValues: { employeeId: '', leaveTypeId: '', startDate: today, endDate: today, isHalfDay: false, ...preset } });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const isHalfDay = useWatch({ control, name: 'isHalfDay' }) ?? false;
  const startDate = useWatch({ control, name: 'startDate' });
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      const res = await createRecord.mutateAsync({ ...v, halfDayPart: v.isHalfDay ? v.halfDayPart : undefined });
      if (res.recalculationJobId) toastJobQueued(res.recalculationJobId, navigate, t('records.recalcHint')); else toast.success(t('records.created'));
      onOpenChange(false);
    } catch (e) { toastMutationError(e, navigate); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('records.add')}</DialogTitle><DialogDescription>{t('records.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('fields.employee')} htmlFor="lr-emp" required error={errors.employeeId?.message}>
              <Controller control={control} name="employeeId" render={({ field }) => <Combobox id="lr-emp" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('fields.selectEmployee')} aria-invalid={!!errors.employeeId} />} />
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
            <Button type="submit" loading={isSubmitting}>{t('records.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
