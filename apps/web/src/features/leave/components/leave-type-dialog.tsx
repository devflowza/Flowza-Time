import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { leaveTypeInputSchema } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { blankToUndefined } from '@/features/organization/form-utils';
import { useLeaveMutations, type LeaveTypeInput } from '../api';
import type { LeaveTypeDto } from '../types';

type FormValues = z.input<typeof leaveTypeInputSchema>;
const COLORS = ['#175cd3', '#0f6e56', '#b54708', '#7a2e9d', '#b42318', '#0e7490', '#475467'];

export function LeaveTypeDialog({ open, onOpenChange, leaveType }: { open: boolean; onOpenChange: (o: boolean) => void; leaveType: LeaveTypeDto | null }) {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const { createType, updateType } = useLeaveMutations();
  const form = useForm<FormValues, unknown, LeaveTypeInput>({ resolver: zodResolver(leaveTypeInputSchema), defaultValues: leaveType ? { code: leaveType.code, name: leaveType.name, nameAr: leaveType.nameAr ?? undefined, isPaid: leaveType.isPaid, color: leaveType.color ?? undefined } : { code: '', name: '', isPaid: true, color: COLORS[0] } });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const color = useWatch({ control, name: 'color' });
  const onSubmit = form.handleSubmit(async (v) => {
    try {
      if (leaveType) { await updateType.mutateAsync({ id: leaveType.id, input: v }); toast.success(t('types.updated')); }
      else { await createType.mutateAsync(v); toast.success(t('types.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{leaveType ? t('types.edit') : t('types.add')}</DialogTitle><DialogDescription>{t('types.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.code')} htmlFor="lt-code" required error={errors.code?.message}><Input id="lt-code" dir="ltr" className="font-mono" {...register('code')} aria-invalid={!!errors.code} disabled={!!leaveType} /></FormField>
            <FormField label={tc('common.name')} htmlFor="lt-name" required error={errors.name?.message}><Input id="lt-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
          </div>
          <FormField label={t('fields.nameAr')} htmlFor="lt-nameAr" optional error={errors.nameAr?.message}><Input id="lt-nameAr" dir="rtl" {...register('nameAr', { setValueAs: blankToUndefined })} /></FormField>
          <Controller control={control} name="isPaid" render={({ field }) => (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3"><div><Label htmlFor="lt-paid">{t('fields.isPaid')}</Label><p className="text-xs text-muted-foreground">{t('fields.isPaidHint')}</p></div><Switch id="lt-paid" checked={field.value ?? true} onCheckedChange={field.onChange} /></div>
          )} />
          <FormField label={t('fields.color')} htmlFor="lt-color" optional error={errors.color?.message}>
            <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('fields.color')}>
              {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={cn('size-7 rounded-full border-2 focus-visible:ring-2 focus-visible:ring-ring', color === c ? 'scale-110 border-foreground' : 'border-transparent')} style={{ backgroundColor: c }} onClick={() => setValue('color', c, { shouldDirty: true })} />)}
              <Input id="lt-color" dir="ltr" className="h-8 w-28 font-mono text-xs" {...register('color', { setValueAs: blankToUndefined })} aria-invalid={!!errors.color} />
            </div>
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{leaveType ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
