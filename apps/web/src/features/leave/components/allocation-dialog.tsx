import { useMemo } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { leaveAllocationRowSchema, type LeaveAllocationRowInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useEmployeeOptions } from '@/features/employees/api';
import { useLeaveAllocationMutations, useLeaveTypes } from '../api';
import type { LeaveAllocationDto } from '../types';

type FormValues = z.input<typeof leaveAllocationRowSchema>;
const num = (v: unknown): unknown => (v === '' || v === null || v === undefined ? undefined : Number(v));
const req = (v: unknown): unknown => (v === '' || v === null || v === undefined ? 0 : Number(v));

/**
 * Create or replace one allocation row (PUT /leave-allocations, a full row): the year's allocated days, days carried from
 * the previous year (with their expiry), an opening balance and a manual adjustment. Balances are computed from these rows.
 */
export function AllocationDialog({ open, onOpenChange, year, allocation }: { open: boolean; onOpenChange: (o: boolean) => void; year: number; allocation: LeaveAllocationDto | null }) {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const employees = useEmployeeOptions();
  const types = useLeaveTypes();
  const { save } = useLeaveAllocationMutations();
  // the comp-off type has no allocations (its balance comes from credits); archived types take no new rows
  const typeOptions = useMemo(() => (types.data ?? []).filter((x) => !x.compOff && (x.status === 'active' || x.id === allocation?.leaveTypeId)).map((x) => ({ value: x.id, label: x.name, description: x.code })), [types.data, allocation?.leaveTypeId]);
  const employeeOptions = allocation && !employees.options.some((o) => o.value === allocation.employeeId) ? [{ value: allocation.employeeId, label: allocation.employeeName }, ...employees.options] : employees.options;
  const form = useForm<FormValues, unknown, LeaveAllocationRowInput>({
    resolver: zodResolver(leaveAllocationRowSchema),
    defaultValues: allocation
      ? { employeeId: allocation.employeeId, leaveTypeId: allocation.leaveTypeId, year, allocatedDays: allocation.allocatedDays, carriedForwardDays: allocation.carriedForwardDays, carriedForwardExpiresOn: allocation.carriedForwardExpiresOn, openingBalanceDays: allocation.openingBalanceDays, adjustmentDays: allocation.adjustmentDays, notes: allocation.notes }
      : { employeeId: '', leaveTypeId: '', year, allocatedDays: 0, carriedForwardDays: 0, carriedForwardExpiresOn: null, openingBalanceDays: 0, adjustmentDays: 0, notes: null },
  });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const carried = Number(useWatch({ control, name: 'carriedForwardDays' }) ?? 0);
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      const res = await save.mutateAsync([{ ...v, year, carriedForwardExpiresOn: v.carriedForwardDays && v.carriedForwardDays > 0 ? v.carriedForwardExpiresOn ?? null : null, notes: v.notes?.trim() ? v.notes.trim() : null }]);
      toast.success(res.unchanged ? t('allocations.unchanged') : t('allocations.saved'));
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  const fieldError = (k: keyof FormValues) => (errors[k] as { message?: string } | undefined)?.message;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{allocation ? t('allocations.edit') : t('allocations.add')}</DialogTitle><DialogDescription>{t('allocations.dialogHint', { year })}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('fields.employee')} htmlFor="al-emp" required error={fieldError('employeeId')}>
              <Controller control={control} name="employeeId" render={({ field }) => <Combobox id="al-emp" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('fields.selectEmployee')} disabled={!!allocation} aria-invalid={!!errors.employeeId} />} />
            </FormField>
            <FormField label={t('fields.leaveType')} htmlFor="al-type" required error={fieldError('leaveTypeId')}>
              <Controller control={control} name="leaveTypeId" render={({ field }) => <Combobox id="al-type" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} options={typeOptions} loading={types.isLoading} placeholder={t('fields.selectLeaveType')} disabled={!!allocation} aria-invalid={!!errors.leaveTypeId} />} />
            </FormField>
            <FormField label={t('allocations.allocated')} htmlFor="al-days" required hint={t('allocations.allocatedHint')} error={fieldError('allocatedDays')}>
              <Input id="al-days" type="number" inputMode="decimal" min={0} max={366} step={0.5} dir="ltr" className="w-32 tnum" {...register('allocatedDays', { setValueAs: req })} aria-invalid={!!errors.allocatedDays} />
            </FormField>
            <FormField label={t('allocations.adjustment')} htmlFor="al-adj" optional hint={t('allocations.adjustmentHint')} error={fieldError('adjustmentDays')}>
              <Input id="al-adj" type="number" inputMode="decimal" min={-366} max={366} step={0.5} dir="ltr" className="w-32 tnum" {...register('adjustmentDays', { setValueAs: num })} aria-invalid={!!errors.adjustmentDays} />
            </FormField>
            <FormField label={t('allocations.carriedForward')} htmlFor="al-cf" optional hint={t('allocations.carriedForwardHint')} error={fieldError('carriedForwardDays')}>
              <Input id="al-cf" type="number" inputMode="decimal" min={0} max={366} step={0.5} dir="ltr" className="w-32 tnum" {...register('carriedForwardDays', { setValueAs: num })} aria-invalid={!!errors.carriedForwardDays} />
            </FormField>
            <FormField label={t('allocations.carriedForwardExpires')} htmlFor="al-cf-exp" optional error={fieldError('carriedForwardExpiresOn')}>
              <Input id="al-cf-exp" type="date" dir="ltr" disabled={!(carried > 0)} {...register('carriedForwardExpiresOn', { setValueAs: (v: unknown) => (v === '' || v === undefined ? null : v) })} aria-invalid={!!errors.carriedForwardExpiresOn} />
            </FormField>
            <FormField label={t('allocations.opening')} htmlFor="al-open" optional hint={t('allocations.openingHint')} error={fieldError('openingBalanceDays')}>
              <Input id="al-open" type="number" inputMode="decimal" min={-366} max={366} step={0.5} dir="ltr" className="w-32 tnum" {...register('openingBalanceDays', { setValueAs: num })} aria-invalid={!!errors.openingBalanceDays} />
            </FormField>
          </div>
          <FormField label={t('allocations.notes')} htmlFor="al-notes" optional error={fieldError('notes')}><Textarea id="al-notes" rows={2} maxLength={1000} {...register('notes')} /></FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{tc('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
