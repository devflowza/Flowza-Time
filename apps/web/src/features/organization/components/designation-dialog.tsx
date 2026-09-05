import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { designationInputSchema, RECORD_STATUSES, type DesignationDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useStructureMutations } from '../api';
import { blankToUndefined, toNumber } from '../form-utils';

type FormValues = z.input<typeof designationInputSchema>;
type Output = z.output<typeof designationInputSchema>;

export function DesignationDialog({ open, onOpenChange, designation }: { open: boolean; onOpenChange: (o: boolean) => void; designation: DesignationDto | null }) {
  const { t } = useTranslation('organization');
  const { t: tc } = useTranslation();
  const { create, update } = useStructureMutations<DesignationDto, Output>('designations');
  const form = useForm<FormValues, unknown, Output>({
    resolver: zodResolver(designationInputSchema),
    defaultValues: designation ? { code: designation.code, name: designation.name, nameAr: designation.nameAr ?? undefined, level: designation.level, status: designation.status } : { code: '', name: '', level: 0, status: 'active' },
  });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (designation) { await update.mutateAsync({ id: designation.id, input: values }); toast.success(t('designations.updated')); }
      else { await create.mutateAsync(values); toast.success(t('designations.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{designation ? t('designations.edit') : t('designations.add')}</DialogTitle></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField label={tc('common.code')} htmlFor="ds-code" required error={errors.code?.message}>
            <Input id="ds-code" dir="ltr" {...register('code')} aria-invalid={!!errors.code} disabled={!!designation} />
          </FormField>
          <FormField label={tc('common.name')} htmlFor="ds-name" required error={errors.name?.message}>
            <Input id="ds-name" {...register('name')} aria-invalid={!!errors.name} />
          </FormField>
          <FormField label={t('fields.nameAr')} htmlFor="ds-nameAr" optional error={errors.nameAr?.message}>
            <Input id="ds-nameAr" dir="rtl" {...register('nameAr', { setValueAs: blankToUndefined })} />
          </FormField>
          <FormField label={t('designations.level')} htmlFor="ds-level" hint={t('designations.levelHint')} error={errors.level?.message}>
            <Input id="ds-level" type="number" min={0} max={100} dir="ltr" className="tnum" {...register('level', { setValueAs: toNumber })} aria-invalid={!!errors.level} />
          </FormField>
          {designation ? (
            <FormField label={tc('common.status')} htmlFor="ds-status">
              <Controller control={control} name="status" render={({ field }) => (
                <Select value={field.value ?? 'active'} onValueChange={field.onChange}>
                  <SelectTrigger id="ds-status"><SelectValue /></SelectTrigger>
                  <SelectContent>{RECORD_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{designation ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
