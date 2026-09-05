import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { createAccessGrantSchema, type CreateAccessGrantInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { blankToUndefined, toOptionalNumber } from '@/features/organization/form-utils';
import { usePlatformMutations } from '../api';

type Values = z.input<typeof createAccessGrantSchema>;

/** Time-boxed support access to a tenant (default 8 h, max 72 h; write grants need a second approver). */
export function GrantDialog({ organizationId, organizationName, open, onOpenChange }: { organizationId: string; organizationName?: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const { createGrant } = usePlatformMutations();
  const form = useForm<Values, unknown, CreateAccessGrantInput>({ resolver: zodResolver(createAccessGrantSchema), defaultValues: { organizationId, accessLevel: 'read', reason: '', ticketRef: undefined, hours: 8, approvedBy: undefined } });
  const { register, control, formState: { errors } } = form;
  const level = useWatch({ control, name: 'accessLevel' });
  const submit = form.handleSubmit((values) => createGrant.mutate(values, { onSuccess: () => { toast.success(t('grants.created')); onOpenChange(false); }, onError: toastError }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('grants.create')}</DialogTitle><DialogDescription>{t('grants.createHint', { org: organizationName ?? organizationId })}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('grants.level')} htmlFor="grant-level" error={errors.accessLevel?.message}>
              <Controller control={control} name="accessLevel" render={({ field }) => <Select value={field.value ?? 'read'} onValueChange={field.onChange}><SelectTrigger id="grant-level"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="read">{t('grants.levels.read')}</SelectItem><SelectItem value="write">{t('grants.levels.write')}</SelectItem></SelectContent></Select>} />
            </FormField>
            <FormField label={t('grants.hours')} htmlFor="grant-hours" required error={errors.hours?.message} hint={t('grants.hoursHint')}>
              <Input id="grant-hours" type="number" min={1} max={72} inputMode="numeric" className="tnum" dir="ltr" {...register('hours', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.hours} />
            </FormField>
          </div>
          <FormField label={t('grants.reason')} htmlFor="grant-reason" required error={errors.reason?.message} hint={t('grants.reasonHint')}>
            <Textarea id="grant-reason" rows={3} {...register('reason')} aria-invalid={!!errors.reason} />
          </FormField>
          <FormField label={t('grants.ticket')} htmlFor="grant-ticket" optional error={errors.ticketRef?.message}>
            <Input id="grant-ticket" dir="ltr" {...register('ticketRef', { setValueAs: blankToUndefined })} />
          </FormField>
          {level === 'write' ? (
            <FormField label={t('grants.approvedBy')} htmlFor="grant-approver" required error={errors.approvedBy?.message} hint={t('grants.approvedByHint')}>
              <Input id="grant-approver" dir="ltr" className="font-mono" placeholder="00000000-0000-0000-0000-000000000000" {...register('approvedBy', { setValueAs: blankToUndefined })} aria-invalid={!!errors.approvedBy} />
            </FormField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={createGrant.isPending}>{t('grants.grant')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
