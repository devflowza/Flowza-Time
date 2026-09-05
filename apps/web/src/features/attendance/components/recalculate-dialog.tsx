import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { recalculateSchema, type RecalculateInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useAttendanceMutations, useInvalidateAttendance } from '../api';
import { toastMutationError } from '../period-locked';
import { EmployeeMultiSelect } from './employee-multi-select';

type FormValues = z.input<typeof recalculateSchema>;

/** Recalculate a date range (branch / department / employees scope) → 202 job. */
export function RecalculateDialog({ open, onOpenChange, preset }: { open: boolean; onOpenChange: (o: boolean) => void; preset?: Partial<FormValues> }) {
  const { t } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const { recalculate } = useAttendanceMutations();
  const invalidate = useInvalidateAttendance();
  const branches = useBranchOptions();
  const today = todayIso(tz);
  const form = useForm<FormValues, unknown, RecalculateInput>({ resolver: zodResolver(recalculateSchema), defaultValues: { fromDate: today, toDate: today, reason: '', employeeIds: [], ...preset } });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const branchId = useWatch({ control, name: 'branchId' });
  const departments = useDepartmentOptions(branchId || undefined);
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload: RecalculateInput = { ...values, employeeIds: values.employeeIds && values.employeeIds.length ? values.employeeIds : undefined, branchId: values.branchId || undefined, departmentId: values.departmentId || undefined };
      const res = await recalculate.mutateAsync(payload);
      toastJobQueued(res.jobId, navigate, t('recalc.queuedHint'), { to: '/attendance?tab=recalc' });
      invalidate();
      onOpenChange(false);
    } catch (e) { toastMutationError(e, navigate); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('recalc.title')}</DialogTitle><DialogDescription>{t('recalc.hint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.from')} htmlFor="rc-from" required error={errors.fromDate?.message}><Input id="rc-from" type="date" dir="ltr" max={today} {...register('fromDate')} aria-invalid={!!errors.fromDate} /></FormField>
            <FormField label={tc('common.to')} htmlFor="rc-to" required error={errors.toDate?.message}><Input id="rc-to" type="date" dir="ltr" max={today} {...register('toDate')} aria-invalid={!!errors.toDate} /></FormField>
            <FormField label={tc('common.branch')} htmlFor="rc-branch" optional error={errors.branchId?.message}>
              <Controller control={control} name="branchId" render={({ field }) => <Combobox id="rc-branch" value={field.value ?? null} onChange={(v) => { field.onChange(v ?? undefined); form.setValue('departmentId', undefined); }} options={branches.options} loading={branches.isLoading} clearable placeholder={t('recalc.allBranches')} />} />
            </FormField>
            <FormField label={tc('common.department')} htmlFor="rc-dept" optional error={errors.departmentId?.message}>
              <Controller control={control} name="departmentId" render={({ field }) => <Combobox id="rc-dept" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={t('recalc.allDepartments')} />} />
            </FormField>
          </div>
          <FormField label={t('recalc.employees')} htmlFor="rc-emps" optional hint={t('recalc.employeesHint')} error={errors.employeeIds?.message}>
            <Controller control={control} name="employeeIds" render={({ field }) => <EmployeeMultiSelect id="rc-emps" value={field.value ?? []} onChange={field.onChange} />} />
          </FormField>
          <FormField label={t('recalc.reason')} htmlFor="rc-reason" required error={errors.reason?.message}><Textarea id="rc-reason" rows={2} placeholder={t('recalc.reasonPlaceholder')} {...register('reason')} aria-invalid={!!errors.reason} /></FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{t('recalc.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
