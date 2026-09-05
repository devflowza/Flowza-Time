import { useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { APPROVAL_ENTITIES, APPROVER_TYPES, RECORD_STATUSES, approvalWorkflowInputSchema, type ApprovalWorkflowInput } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useBranchOptions } from '@/features/organization/lookups';
import { useMembers, useRoles } from '@/features/users/api';
import { useWorkflowMutations, type WorkflowDto } from '../api';

type FormValues = z.input<typeof approvalWorkflowInputSchema>;
const MAX_STEPS = 5;

function toDefaults(w: WorkflowDto | null): FormValues {
  if (!w) return { name: '', entityType: 'ATTENDANCE_CORRECTION', branchId: null, isDefault: true, status: 'active', steps: [{ order: 1, approverType: 'MANAGER' }] };
  return { name: w.name, entityType: w.entityType as FormValues['entityType'], branchId: w.branchId, isDefault: w.isDefault, status: w.status as FormValues['status'], steps: w.steps.map((s, i) => ({ order: i + 1, approverType: s.approverType, roleId: s.roleId, userId: s.userId })) };
}

/** Approval workflow editor: name, entity, branch scope, default flag and an ordered steps builder (MANAGER / ROLE / USER). */
export function WorkflowDialog({ open, onOpenChange, workflow }: { open: boolean; onOpenChange: (o: boolean) => void; workflow: WorkflowDto | null }) {
  const { t } = useTranslation('approvals');
  const { t: tc } = useTranslation();
  const { create, update } = useWorkflowMutations();
  const branches = useBranchOptions();
  const roles = useRoles();
  const [memberSearch, setMemberSearch] = useState('');
  const members = useMembers({ search: memberSearch || undefined, pageSize: 20, sort: 'fullName', status: 'active' });
  const roleOptions = useMemo(() => (roles.data ?? []).map((r) => ({ value: r.id, label: r.name, description: r.isSystem ? t('workflows.systemRole') : undefined })), [roles.data, t]);
  const memberOptions = useMemo(() => (members.data?.data ?? []).map((m) => ({ value: m.userId, label: m.fullName || m.email, description: m.email })), [members.data]);
  const form = useForm<FormValues, unknown, ApprovalWorkflowInput>({ resolver: zodResolver(approvalWorkflowInputSchema), defaultValues: toDefaults(workflow) });
  const { register, control, formState: { errors, isSubmitting }, setValue, getValues } = form;
  const steps = useFieldArray({ control, name: 'steps' });
  const watchedSteps = useWatch({ control, name: 'steps' }) ?? [];
  const renumber = () => getValues('steps').forEach((_s, i) => setValue(`steps.${i}.order`, i + 1));
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = { ...values, steps: values.steps.map((s, i) => ({ order: i + 1, approverType: s.approverType, roleId: s.approverType === 'ROLE' ? s.roleId : undefined, userId: s.approverType === 'USER' ? s.userId : undefined })) };
      if (workflow) { await update.mutateAsync({ id: workflow.id, input: payload }); toast.success(t('workflows.updated')); }
      else { await create.mutateAsync(payload); toast.success(t('workflows.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  const stepErrors = Array.isArray(errors.steps) ? errors.steps : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{workflow ? t('workflows.edit') : t('workflows.add')}</DialogTitle><DialogDescription>{t('workflows.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.name')} htmlFor="wf-name" required error={errors.name?.message}><Input id="wf-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={t('workflows.entityType')} htmlFor="wf-entity" error={errors.entityType?.message}>
              <Controller control={control} name="entityType" render={({ field }) => (
                <Select value={field.value ?? 'ATTENDANCE_CORRECTION'} onValueChange={field.onChange}>
                  <SelectTrigger id="wf-entity"><SelectValue /></SelectTrigger>
                  <SelectContent>{APPROVAL_ENTITIES.map((e) => <SelectItem key={e} value={e}>{t(`entity.${e}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label={t('workflows.branchScope')} htmlFor="wf-branch" optional hint={t('workflows.branchScopeHint')} error={errors.branchId?.message}>
              <Controller control={control} name="branchId" render={({ field }) => <Combobox id="wf-branch" value={field.value ?? null} onChange={(v) => field.onChange(v)} options={branches.options} loading={branches.isLoading} clearable placeholder={t('workflows.allBranches')} />} />
            </FormField>
            <FormField label={tc('common.status')} htmlFor="wf-status" error={errors.status?.message}>
              <Controller control={control} name="status" render={({ field }) => (
                <Select value={field.value ?? 'active'} onValueChange={field.onChange}>
                  <SelectTrigger id="wf-status"><SelectValue /></SelectTrigger>
                  <SelectContent>{RECORD_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`recordStatus.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
          </div>
          <Controller control={control} name="isDefault" render={({ field }) => (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div><Label htmlFor="wf-default">{t('workflows.isDefault')}</Label><p className="text-xs text-muted-foreground">{t('workflows.isDefaultHint')}</p></div>
              <Switch id="wf-default" checked={field.value ?? true} onCheckedChange={field.onChange} />
            </div>
          )} />

          <section className="space-y-2">
            <div className="flex items-center justify-between"><h4 className="text-sm font-semibold">{t('workflows.steps')}</h4><span className="text-xs text-muted-foreground">{t('workflows.stepsCount', { count: steps.fields.length, max: MAX_STEPS })}</span></div>
            {typeof errors.steps?.message === 'string' ? <p className="text-xs text-destructive" role="alert">{errors.steps.message}</p> : null}
            <ol className="space-y-2">
              {steps.fields.map((fld, i) => {
                const type = watchedSteps[i]?.approverType ?? fld.approverType;
                const err = stepErrors[i];
                return (
                  <li key={fld.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-start">
                    <Badge variant="outline" className="mt-2 tnum">{i + 1}</Badge>
                    <FormField label={t('workflows.approverType')} htmlFor={`wf-step-${i}-type`} error={err?.approverType?.message}>
                      <Controller control={control} name={`steps.${i}.approverType`} render={({ field }) => (
                        <Select value={field.value} onValueChange={(v) => { field.onChange(v); setValue(`steps.${i}.roleId`, undefined); setValue(`steps.${i}.userId`, undefined); }}>
                          <SelectTrigger id={`wf-step-${i}-type`}><SelectValue /></SelectTrigger>
                          <SelectContent>{APPROVER_TYPES.map((a) => <SelectItem key={a} value={a}>{t(`approverType.${a}`)}</SelectItem>)}</SelectContent>
                        </Select>
                      )} />
                    </FormField>
                    {type === 'ROLE' ? (
                      <FormField label={t('workflows.role')} htmlFor={`wf-step-${i}-role`} required error={err?.roleId?.message}>
                        <Controller control={control} name={`steps.${i}.roleId`} render={({ field }) => <Combobox id={`wf-step-${i}-role`} value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={roleOptions} loading={roles.isLoading} placeholder={t('workflows.selectRole')} aria-invalid={!!err?.roleId} />} />
                      </FormField>
                    ) : type === 'USER' ? (
                      <FormField label={t('workflows.user')} htmlFor={`wf-step-${i}-user`} required error={err?.userId?.message}>
                        <Controller control={control} name={`steps.${i}.userId`} render={({ field }) => <Combobox id={`wf-step-${i}-user`} value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={memberOptions} onSearch={setMemberSearch} loading={members.isLoading} placeholder={t('workflows.selectUser')} aria-invalid={!!err?.userId} />} />
                      </FormField>
                    ) : <p className="self-center text-xs text-muted-foreground sm:pt-6">{t('workflows.managerHint')}</p>}
                    <div className="flex items-center gap-1 sm:pt-5">
                      <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('workflows.moveUp')} disabled={i === 0} onClick={() => { steps.swap(i, i - 1); renumber(); }}><ArrowUp /></Button>
                      <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('workflows.moveDown')} disabled={i === steps.fields.length - 1} onClick={() => { steps.swap(i, i + 1); renumber(); }}><ArrowDown /></Button>
                      <Button type="button" variant="ghost" size="icon" className="size-8 text-destructive" aria-label={t('workflows.removeStep')} disabled={steps.fields.length <= 1} onClick={() => { steps.remove(i); renumber(); }}><Trash2 /></Button>
                    </div>
                  </li>
                );
              })}
            </ol>
            <Button type="button" variant="outline" size="sm" disabled={steps.fields.length >= MAX_STEPS} onClick={() => steps.append({ order: steps.fields.length + 1, approverType: 'ROLE' })}><Plus /> {t('workflows.addStep')}</Button>
          </section>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{workflow ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
