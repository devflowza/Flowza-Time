import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { employeeGroupInputSchema, type EmployeeGroupDto, type EmployeeGroupInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { blankToNull } from '@/features/organization/form-utils';
import { POLICIES_NS } from '../i18n';
import { useEmployeeGroupMutations } from '../api';

type FormValues = z.input<typeof employeeGroupInputSchema>;

/** Create or edit an employee group (code, names, description, status). */
export function GroupDialog({ open, onOpenChange, group }: { open: boolean; onOpenChange: (o: boolean) => void; group: EmployeeGroupDto | null }) {
  const { t } = useTranslation(POLICIES_NS);
  const { t: tc } = useTranslation();
  const { create, update } = useEmployeeGroupMutations();
  const form = useForm<FormValues, unknown, EmployeeGroupInput>({
    resolver: zodResolver(employeeGroupInputSchema),
    defaultValues: group ? { code: group.code, name: group.name, nameAr: group.nameAr, description: group.description, status: group.status } : { code: '', name: '', nameAr: null, description: '', status: 'active' },
  });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (group) await update.mutateAsync({ id: group.id, input: values }); else await create.mutateAsync(values);
      toast.success(group ? t('groups.updated') : t('groups.created'));
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{group ? t('groups.edit') : t('groups.add')}</DialogTitle><DialogDescription>{t('groups.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.code')} htmlFor="eg-code" required error={errors.code?.message}><Input id="eg-code" dir="ltr" maxLength={32} {...register('code')} aria-invalid={!!errors.code} /></FormField>
            <FormField label={t('groups.status')} htmlFor="eg-status">
              <Controller control={control} name="status" render={({ field }) => (
                <Select value={field.value ?? 'active'} onValueChange={field.onChange}><SelectTrigger id="eg-status"><SelectValue /></SelectTrigger><SelectContent>{(['active', 'inactive'] as const).map((s) => <SelectItem key={s} value={s}>{t(`groups.statuses.${s}`)}</SelectItem>)}</SelectContent></Select>
              )} />
            </FormField>
            <FormField label={tc('common.name')} htmlFor="eg-name" required error={errors.name?.message}><Input id="eg-name" maxLength={120} {...register('name')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={t('groups.nameAr')} htmlFor="eg-name-ar" optional error={errors.nameAr?.message}><Input id="eg-name-ar" dir="rtl" maxLength={120} {...register('nameAr', { setValueAs: blankToNull })} /></FormField>
          </div>
          <FormField label={t('groups.description')} htmlFor="eg-description" optional error={errors.description?.message}><Input id="eg-description" maxLength={500} {...register('description')} /></FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{group ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
