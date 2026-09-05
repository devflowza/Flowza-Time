import { useForm, useWatch, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { MEMBERSHIP_STATUSES, updateMemberSchema, type MemberDto } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useBranchOptions } from '@/features/organization/lookups';
import { useEmployeeOptions } from '@/features/employees/api';
import { useMemberMutations, useRoles, type UpdateMemberInput } from '../api';

type FormValues = z.input<typeof updateMemberSchema>;

export function MemberDialog({ member, onClose }: { member: MemberDto; onClose: () => void }) {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation();
  const roles = useRoles();
  const branches = useBranchOptions();
  const employees = useEmployeeOptions();
  const { update } = useMemberMutations();
  const form = useForm<FormValues, unknown, UpdateMemberInput>({ resolver: zodResolver(updateMemberSchema), defaultValues: { roleId: member.roleId, status: member.status, allBranches: member.allBranches, branchIds: member.branchIds, employeeId: member.employeeId } });
  const { control, formState: { errors, isSubmitting }, setValue } = form;
  const allBranches = useWatch({ control, name: 'allBranches' }) ?? true;
  const branchIds = useWatch({ control, name: 'branchIds' }) ?? [];
  const scopeInvalid = !allBranches && branchIds.length === 0;

  const onSubmit = form.handleSubmit(async (values) => {
    if (scopeInvalid) return;
    try { await update.mutateAsync({ id: member.id, input: values }); toast.success(t('members.updated', { name: member.fullName })); onClose(); } catch (e) { toastError(e); }
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('members.edit', { name: member.fullName })}</DialogTitle>
          <DialogDescription dir="ltr" className="text-start">{member.email}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField label={t('fields.role')} htmlFor="mem-role" error={errors.roleId?.message} hint={member.roleKey === 'owner' ? t('members.ownerHint') : undefined}>
            <Controller control={control} name="roleId" render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="mem-role"><SelectValue /></SelectTrigger>
                <SelectContent>{(roles.data ?? []).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}{r.isSystem ? '' : ` · ${t('roles.custom')}`}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div><Label htmlFor="mem-all">{t('fields.allBranches')}</Label><p className="text-xs text-muted-foreground">{t('fields.allBranchesHint')}</p></div>
            <Switch id="mem-all" checked={allBranches} onCheckedChange={(v) => { setValue('allBranches', v, { shouldDirty: true }); if (v) setValue('branchIds', []); }} />
          </div>
          {!allBranches ? (
            <FormField label={t('fields.branches')} htmlFor="mem-branches" required error={scopeInvalid ? t('fields.branchesRequired') : undefined}>
              <ul id="mem-branches" className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
                {branches.data.map((b) => (
                  <li key={b.id} className="flex items-center gap-2 text-sm">
                    <Checkbox id={`mem-b-${b.id}`} checked={branchIds.includes(b.id)} onCheckedChange={(v) => setValue('branchIds', v ? [...branchIds, b.id] : branchIds.filter((x) => x !== b.id), { shouldDirty: true })} />
                    <Label htmlFor={`mem-b-${b.id}`}>{b.name}</Label>
                  </li>
                ))}
              </ul>
            </FormField>
          ) : null}
          <FormField label={t('fields.linkEmployee')} htmlFor="mem-emp" optional hint={t('fields.linkEmployeeHint')}>
            <Controller control={control} name="employeeId" render={({ field }) => <Combobox id="mem-emp" value={field.value} onChange={(v) => field.onChange(v)} options={member.employeeId && !employees.options.some((o) => o.value === member.employeeId) ? [{ value: member.employeeId, label: member.employeeNumber ?? member.employeeId }, ...employees.options] : employees.options} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={tc('common.none')} />} />
          </FormField>
          <FormField label={tc('common.status')} htmlFor="mem-status" hint={t('members.statusHint')}>
            <Controller control={control} name="status" render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="mem-status"><SelectValue /></SelectTrigger>
                <SelectContent>{MEMBERSHIP_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting} disabled={scopeInvalid}>{tc('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
