import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { departmentInputSchema, RECORD_STATUSES, type DepartmentDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useEmployeeOptions } from '@/features/employees/api';
import { useStructureMutations } from '../api';
import { useBranchOptions, useDepartmentOptions } from '../lookups';
import { blankToUndefined } from '../form-utils';

type FormValues = z.input<typeof departmentInputSchema>;
type Output = z.output<typeof departmentInputSchema>;

export function DepartmentDialog({ open, onOpenChange, department, parentId }: { open: boolean; onOpenChange: (o: boolean) => void; department: DepartmentDto | null; parentId?: string | null }) {
  const { t } = useTranslation('organization');
  const { t: tc } = useTranslation();
  const { create, update } = useStructureMutations<DepartmentDto, Output>('departments');
  const branches = useBranchOptions();
  const departments = useDepartmentOptions();
  const managers = useEmployeeOptions();
  const form = useForm<FormValues, unknown, Output>({
    resolver: zodResolver(departmentInputSchema),
    defaultValues: department
      ? { code: department.code, name: department.name, nameAr: department.nameAr ?? undefined, branchId: department.branchId, parentId: department.parentId, managerEmployeeId: department.managerEmployeeId, status: department.status }
      : { code: '', name: '', branchId: null, parentId: parentId ?? null, managerEmployeeId: null, status: 'active' },
  });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const parentOptions = departments.options.filter((o) => o.value !== department?.id);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (department) { await update.mutateAsync({ id: department.id, input: values }); toast.success(t('departments.updated')); }
      else { await create.mutateAsync(values); toast.success(t('departments.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{department ? t('departments.edit') : t('departments.add')}</DialogTitle>
          <DialogDescription>{t('departments.dialogHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.code')} htmlFor="dp-code" required error={errors.code?.message}>
              <Input id="dp-code" dir="ltr" {...register('code')} aria-invalid={!!errors.code} disabled={!!department} />
            </FormField>
            <FormField label={tc('common.name')} htmlFor="dp-name" required error={errors.name?.message}>
              <Input id="dp-name" {...register('name')} aria-invalid={!!errors.name} />
            </FormField>
          </div>
          <FormField label={t('fields.nameAr')} htmlFor="dp-nameAr" optional error={errors.nameAr?.message}>
            <Input id="dp-nameAr" dir="rtl" {...register('nameAr', { setValueAs: blankToUndefined })} />
          </FormField>
          <FormField label={tc('common.branch')} htmlFor="dp-branch" optional hint={t('departments.branchHint')} error={errors.branchId?.message}>
            <Controller control={control} name="branchId" render={({ field }) => <Combobox id="dp-branch" value={field.value} onChange={field.onChange} options={branches.options} loading={branches.isLoading} clearable placeholder={t('departments.allBranches')} />} />
          </FormField>
          <FormField label={t('departments.parent')} htmlFor="dp-parent" optional error={errors.parentId?.message}>
            <Controller control={control} name="parentId" render={({ field }) => <Combobox id="dp-parent" value={field.value} onChange={field.onChange} options={parentOptions} loading={departments.isLoading} clearable placeholder={t('departments.topLevel')} />} />
          </FormField>
          <FormField label={t('departments.manager')} htmlFor="dp-manager" optional error={errors.managerEmployeeId?.message}>
            <Controller control={control} name="managerEmployeeId" render={({ field }) => <Combobox id="dp-manager" value={field.value} onChange={field.onChange} options={managers.options} onSearch={managers.setSearch} loading={managers.isLoading} clearable placeholder={t('departments.noManager')} />} />
          </FormField>
          {department ? (
            <FormField label={tc('common.status')} htmlFor="dp-status">
              <Controller control={control} name="status" render={({ field }) => (
                <Select value={field.value ?? 'active'} onValueChange={field.onChange}>
                  <SelectTrigger id="dp-status" className="sm:w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>{RECORD_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{department ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
