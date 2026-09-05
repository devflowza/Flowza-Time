import { useState } from 'react';
import { useForm, useWatch, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, MailCheck } from 'lucide-react';
import { inviteMemberSchema, type InvitationDto, type InviteMemberInput } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDateTime } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useEmployeeOptions } from '@/features/employees/api';
import { CopyButton } from '@/features/audit/components/copy-button';
import { useMemberMutations, useRoles } from '../api';

type FormValues = z.input<typeof inviteMemberSchema>;

export function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const roles = useRoles();
  const branches = useBranchOptions();
  const employees = useEmployeeOptions();
  const { invite } = useMemberMutations();
  const [result, setResult] = useState<InvitationDto | null>(null);
  const form = useForm<FormValues, unknown, InviteMemberInput>({ resolver: zodResolver(inviteMemberSchema), defaultValues: { email: '', roleId: '', allBranches: true, branchIds: [] } });
  const { register, control, formState: { errors, isSubmitting }, setValue } = form;
  const allBranches = useWatch({ control, name: 'allBranches' }) ?? true;
  const branchIds = useWatch({ control, name: 'branchIds' }) ?? [];

  const onSubmit = form.handleSubmit(async (values) => {
    try { setResult(await invite.mutateAsync(values)); } catch (e) { toastError(e); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><MailCheck className="size-5 text-emerald-600" /> {t('invite.createdTitle')}</DialogTitle>
              <DialogDescription>{result.membershipId ? t('invite.createdExisting', { email: result.email }) : t('invite.createdHint', { email: result.email })}</DialogDescription>
            </DialogHeader>
            {result.token ? (
              <div className="space-y-2">
                <Label htmlFor="invite-token">{t('invite.token')}</Label>
                <div className="flex items-center gap-2">
                  <Input id="invite-token" readOnly value={result.token} dir="ltr" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                  <CopyButton value={result.token} variant="outline" label={t('invite.copyToken')} />
                </div>
                <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {t('invite.tokenOnce', { expires: fmtDateTime(result.expiresAt, tz) })}</p>
              </div>
            ) : null}
            <DialogFooter><Button onClick={() => onOpenChange(false)}>{tc('common.close')}</Button></DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('invite.title')}</DialogTitle>
              <DialogDescription>{t('invite.hint')}</DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <FormField label={t('fields.email')} htmlFor="inv-email" required error={errors.email?.message}>
                <Input id="inv-email" type="email" dir="ltr" autoComplete="off" {...register('email')} aria-invalid={!!errors.email} />
              </FormField>
              <FormField label={t('fields.role')} htmlFor="inv-role" required error={errors.roleId?.message}>
                <Controller control={control} name="roleId" render={({ field }) => (
                  <Select value={field.value || undefined} onValueChange={field.onChange}>
                    <SelectTrigger id="inv-role" aria-invalid={!!errors.roleId}><SelectValue placeholder={t('fields.selectRole')} /></SelectTrigger>
                    <SelectContent>{(roles.data ?? []).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}{r.isSystem ? '' : ` · ${t('roles.custom')}`}</SelectItem>)}</SelectContent>
                  </Select>
                )} />
              </FormField>
              <div className="flex items-center justify-between rounded-md border p-3">
                <div><Label htmlFor="inv-all">{t('fields.allBranches')}</Label><p className="text-xs text-muted-foreground">{t('fields.allBranchesHint')}</p></div>
                <Switch id="inv-all" checked={allBranches} onCheckedChange={(v) => { setValue('allBranches', v, { shouldDirty: true, shouldValidate: true }); if (v) setValue('branchIds', []); }} />
              </div>
              {!allBranches ? (
                <FormField label={t('fields.branches')} htmlFor="inv-branches" required error={errors.branchIds?.message}>
                  <ul id="inv-branches" className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2" aria-invalid={!!errors.branchIds}>
                    {branches.data.map((b) => (
                      <li key={b.id} className="flex items-center gap-2 text-sm">
                        <Checkbox id={`inv-b-${b.id}`} checked={branchIds.includes(b.id)} onCheckedChange={(v) => setValue('branchIds', v ? [...branchIds, b.id] : branchIds.filter((x) => x !== b.id), { shouldDirty: true, shouldValidate: true })} />
                        <Label htmlFor={`inv-b-${b.id}`}>{b.name}</Label>
                      </li>
                    ))}
                    {branches.data.length === 0 ? <li className="text-xs text-muted-foreground">{t('fields.noBranches')}</li> : null}
                  </ul>
                </FormField>
              ) : null}
              <FormField label={t('fields.linkEmployee')} htmlFor="inv-emp" optional hint={t('fields.linkEmployeeHint')}>
                <Controller control={control} name="employeeId" render={({ field }) => <Combobox id="inv-emp" value={field.value} onChange={(v) => field.onChange(v ?? undefined)} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={tc('common.none')} />} />
              </FormField>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
                <Button type="submit" loading={isSubmitting}>{t('invite.send')}</Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
