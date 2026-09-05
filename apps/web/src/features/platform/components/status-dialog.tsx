import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { ORG_STATUSES, updateOrganizationStatusSchema, type OrgStatus } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { usePlatformMutations, type StatusInput } from '../api';

/** Suspend / reactivate / close a tenant; the reason is audited with actor type PLATFORM_ADMIN and visible to the tenant. */
export function StatusDialog({ orgId, current, open, onOpenChange }: { orgId: string; current: OrgStatus; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const { updateStatus } = usePlatformMutations();
  const form = useForm<StatusInput>({ resolver: zodResolver(updateOrganizationStatusSchema), defaultValues: { status: current, reason: '' } });
  const { register, control, formState: { errors } } = form;
  const next = useWatch({ control, name: 'status' });
  const submit = form.handleSubmit((values) => updateStatus.mutate({ id: orgId, input: values }, { onSuccess: () => { toast.success(t('orgs.statusChanged', { status: t(`status.${values.status}`) })); onOpenChange(false); }, onError: toastError }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('orgs.changeStatus')}</DialogTitle><DialogDescription>{t('orgs.changeStatusHint')}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormField label={tc('common.status')} htmlFor="org-status" required error={errors.status?.message}>
            <Controller control={control} name="status" render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="org-status"><SelectValue /></SelectTrigger>
                <SelectContent>{ORG_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          {next === 'closed' ? <p role="alert" className="rounded-md border border-red-300/60 bg-red-50 p-3 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200">{t('orgs.closeWarning')}</p> : null}
          <FormField label={t('orgs.reason')} htmlFor="org-status-reason" required error={errors.reason?.message} hint={t('orgs.reasonHint')}>
            <Textarea id="org-status-reason" rows={3} {...register('reason')} aria-invalid={!!errors.reason} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" variant={next === 'closed' || next === 'suspended' ? 'destructive' : 'default'} disabled={next === current} loading={updateStatus.isPending}>{tc('common.confirm')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
