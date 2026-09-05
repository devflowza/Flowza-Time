import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { updateEmployeeSchema, type UpdateEmployeeInput } from '@flowza/contracts';
import { Button } from '@/components/ui';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeMutations, type EmployeeDetail } from '../../api';
import { EmployeeFormFields, type EmployeeFormValues } from '../employee-form-fields';
import { diffEmployee, EFFECTIVE_DATED_FIELDS, toFormValues } from '../../employee-diff';
import { EffectiveChangeDialog } from '../effective-change-dialog';

export function OverviewTab({ employee }: { employee: EmployeeDetail }) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canEdit = can('employee.update');
  const tz = useOrgTimezone();
  const { update } = useEmployeeMutations();
  const initial = toFormValues(employee);
  const form = useForm<EmployeeFormValues, unknown, UpdateEmployeeInput>({ resolver: zodResolver(updateEmployeeSchema) as unknown as Resolver<EmployeeFormValues, unknown, UpdateEmployeeInput>, defaultValues: initial, disabled: !canEdit });
  const [pending, setPending] = useState<{ patch: UpdateEmployeeInput; fields: string[] } | null>(null);

  const save = async (patch: UpdateEmployeeInput) => {
    try {
      const updated = await update.mutateAsync({ id: employee.id, input: patch });
      toast.success(t('form.saved', { name: updated.displayName }));
      setPending(null);
      form.reset(toFormValues({ ...employee, ...updated }));
    } catch (e) { toastError(e); }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const patch = diffEmployee(initial, values);
    if (Object.keys(patch).length === 0) { toast.info(t('form.noChanges')); return; }
    const effective = EFFECTIVE_DATED_FIELDS.filter((f) => f in patch);
    if (effective.length > 0) { setPending({ patch, fields: [...effective] }); return; }
    await save(patch);
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <EmployeeFormFields form={form} mode="edit" excludeEmployeeId={employee.id} />
      {canEdit ? (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={!form.formState.isDirty} onClick={() => form.reset(initial)}>{t('form.discard')}</Button>
          <Button type="submit" loading={form.formState.isSubmitting || update.isPending} disabled={!form.formState.isDirty}>{tc('common.save')}</Button>
        </div>
      ) : null}
      {pending ? (
        <EffectiveChangeDialog open onOpenChange={(o) => !o && setPending(null)} changedFields={pending.fields} defaultDate={todayIso(tz)} minDate={employee.currentHistory?.effectiveFrom ?? employee.joiningDate} loading={update.isPending}
          onConfirm={({ effectiveFrom, changeReason }) => void save({ ...pending.patch, effectiveFrom, changeReason })} />
      ) : null}
    </form>
  );
}
