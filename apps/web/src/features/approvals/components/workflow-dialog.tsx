import { useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch, type Control } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { APPROVAL_ENTITIES, APPROVAL_ESCALATION_TARGETS, APPROVAL_STEP_MODES, APPROVER_TYPES, PERMISSIONS, RECORD_STATUSES, SINGLE_SEAT_QUORUM_MESSAGE, approvalWorkflowInputSchema, type ApprovalWorkflowInput } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { useMembers, useRoles } from '@/features/users/api';
import { useWorkflowMutations, type WorkflowDto } from '../api';

type FormValues = z.input<typeof approvalWorkflowInputSchema>;
type StepValues = FormValues['steps'][number];
const MAX_STEPS = 5;
/** Keys that decide approvals first in the permission picker; the rest follow alphabetically. */
const DECIDING_KEYS = ['attendance.approve', 'leave.approve', 'approval.manage'];

function toDefaults(w: WorkflowDto | null): FormValues {
  if (!w) return { name: '', entityType: 'ATTENDANCE_CORRECTION', branchId: null, isDefault: true, status: 'active', steps: [{ order: 1, approverType: 'MANAGER', mode: 'ANY' }], appliesTo: {}, minUnits: null };
  return {
    name: w.name, entityType: w.entityType, branchId: w.branchId, isDefault: w.isDefault, status: w.status as FormValues['status'], appliesTo: { ...w.appliesTo }, minUnits: w.minUnits,
    steps: w.steps.map((s, i) => ({ ...s, order: i + 1 })),
  };
}

/** Keep only the fields the step's approver type uses (the API rejects nothing extra, but the stored shape stays clean). */
function cleanStep(s: StepValues, i: number): StepValues {
  const out: StepValues = { order: i + 1, approverType: s.approverType, mode: s.mode ?? 'ANY' };
  if (s.approverType === 'ROLE') { if (s.permission) out.permission = s.permission; else if (s.roleId) out.roleId = s.roleId; }
  if (s.approverType === 'USER' && s.userId) out.userId = s.userId;
  if (s.approverType === 'MANAGER_CHAIN') out.chainLevel = s.chainLevel ?? 1;
  if (out.mode === 'QUORUM') out.requiredCount = s.requiredCount ?? 2;
  if (s.escalateTo && s.escalateAfterHours) { out.escalateTo = s.escalateTo; out.escalateAfterHours = s.escalateAfterHours; }
  return out;
}

/** A small multi-select: pick from a combobox, remove as chips. */
function ChipPicker({ id, values, onChange, options, placeholder }: { id: string; values: string[]; onChange: (next: string[]) => void; options: ComboboxOption[]; placeholder: string }) {
  const byId = new Map(options.map((o) => [o.value, o.label]));
  return (
    <div className="space-y-2">
      <Combobox id={id} value={null} onChange={(v) => { if (v && !values.includes(v)) onChange([...values, v]); }} options={options.filter((o) => !values.includes(o.value))} placeholder={placeholder} />
      {values.length ? <div className="flex flex-wrap gap-1.5">{values.map((v) => <Badge key={v} variant="secondary" className="gap-1">{byId.get(v) ?? v.slice(0, 8)}<button type="button" aria-label={`remove ${byId.get(v) ?? v}`} onClick={() => onChange(values.filter((x) => x !== v))}><X className="size-3" /></button></Badge>)}</div> : null}
    </div>
  );
}

function StepEditor({ i, control, count, onMove, onRemove, setValue, roleOptions, memberOptions, onMemberSearch, loading, errors }: {
  i: number; control: Control<FormValues, unknown, ApprovalWorkflowInput>; count: number; onMove: (from: number, to: number) => void; onRemove: () => void;
  setValue: (name: `steps.${number}.${keyof StepValues}`, value: unknown) => void; roleOptions: ComboboxOption[]; memberOptions: ComboboxOption[]; onMemberSearch: (q: string) => void; loading: { roles: boolean; members: boolean };
  errors: Partial<Record<keyof StepValues, { message?: string }>> | undefined;
}) {
  const { t } = useTranslation('approvals');
  const step = useWatch({ control, name: `steps.${i}` }) as StepValues | undefined;
  // the schema's message for a quorum above one on a single-seat approver type, in the reader's language (review P2-7)
  const requiredCountError = errors?.requiredCount?.message === SINGLE_SEAT_QUORUM_MESSAGE ? t('workflows.singleSeatQuorum') : errors?.requiredCount?.message;
  const type = step?.approverType ?? 'MANAGER';
  const [roleBy, setRoleBy] = useState<'permission' | 'role'>(step?.roleId && !step.permission ? 'role' : 'permission');
  const permissionOptions = useMemo<ComboboxOption[]>(() => [...PERMISSIONS].sort((a, b) => (DECIDING_KEYS.includes(a) ? -1 : 0) - (DECIDING_KEYS.includes(b) ? -1 : 0) || a.localeCompare(b)).map((p) => ({ value: p, label: p })), []);
  return (
    <li className="space-y-3 rounded-md border p-3" data-testid={`wf-step-${i}`}>
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="tnum">{t('levelN', { n: i + 1 })}</Badge>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('workflows.moveUp')} disabled={i === 0} onClick={() => onMove(i, i - 1)}><ArrowUp /></Button>
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('workflows.moveDown')} disabled={i === count - 1} onClick={() => onMove(i, i + 1)}><ArrowDown /></Button>
          <Button type="button" variant="ghost" size="icon" className="size-8 text-destructive" aria-label={t('workflows.removeStep')} disabled={count <= 1} onClick={onRemove}><Trash2 /></Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t('workflows.approverType')} htmlFor={`wf-step-${i}-type`} error={errors?.approverType?.message}>
          <Controller control={control} name={`steps.${i}.approverType`} render={({ field }) => (
            <Select value={field.value} onValueChange={(v) => { field.onChange(v); for (const k of ['roleId', 'userId', 'permission', 'chainLevel'] as const) setValue(`steps.${i}.${k}`, undefined); if (v === 'MANAGER_CHAIN') setValue(`steps.${i}.chainLevel`, 2); if (v === 'ROLE') setValue(`steps.${i}.permission`, 'attendance.approve'); }}>
              <SelectTrigger id={`wf-step-${i}-type`}><SelectValue /></SelectTrigger>
              <SelectContent>{APPROVER_TYPES.map((a) => <SelectItem key={a} value={a}>{t(`approverType.${a}`)}</SelectItem>)}</SelectContent>
            </Select>
          )} />
        </FormField>
        {type === 'ROLE' ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs" role="radiogroup" aria-label={t('workflows.roleBy')}>
              <span className="text-muted-foreground">{t('workflows.roleBy')}:</span>
              {(['permission', 'role'] as const).map((b) => <Button key={b} type="button" size="sm" variant={roleBy === b ? 'default' : 'outline'} className="h-7" role="radio" aria-checked={roleBy === b} onClick={() => { setRoleBy(b); setValue(`steps.${i}.${b === 'permission' ? 'roleId' : 'permission'}`, undefined); }}>{b === 'permission' ? t('workflows.byPermission') : t('workflows.byRole')}</Button>)}
            </div>
            {roleBy === 'permission' ? (
              <Controller control={control} name={`steps.${i}.permission`} render={({ field }) => <Combobox id={`wf-step-${i}-permission`} value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={permissionOptions} placeholder={t('workflows.selectPermission')} aria-invalid={!!errors?.roleId} />} />
            ) : (
              <Controller control={control} name={`steps.${i}.roleId`} render={({ field }) => <Combobox id={`wf-step-${i}-role`} value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={roleOptions} loading={loading.roles} placeholder={t('workflows.selectRole')} aria-invalid={!!errors?.roleId} />} />
            )}
            {errors?.roleId?.message ? <p className="text-xs text-destructive">{errors.roleId.message}</p> : null}
          </div>
        ) : type === 'USER' ? (
          <FormField label={t('workflows.user')} htmlFor={`wf-step-${i}-user`} required error={errors?.userId?.message}>
            <Controller control={control} name={`steps.${i}.userId`} render={({ field }) => <Combobox id={`wf-step-${i}-user`} value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={memberOptions} onSearch={onMemberSearch} loading={loading.members} placeholder={t('workflows.selectUser')} aria-invalid={!!errors?.userId} />} />
          </FormField>
        ) : type === 'MANAGER_CHAIN' ? (
          <FormField label={t('workflows.chainLevel')} htmlFor={`wf-step-${i}-chain`} error={errors?.chainLevel?.message} hint={t('workflows.hint.MANAGER_CHAIN')}>
            <Controller control={control} name={`steps.${i}.chainLevel`} render={({ field }) => <Input id={`wf-step-${i}-chain`} type="number" min={1} max={10} value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value === '' ? undefined : Number(e.target.value))} />} />
          </FormField>
        ) : <p className="self-center text-xs text-muted-foreground sm:pt-6">{t(`workflows.hint.${type}`)}</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <FormField label={t('workflows.mode')} htmlFor={`wf-step-${i}-mode`}>
          <Controller control={control} name={`steps.${i}.mode`} render={({ field }) => (
            <Select value={field.value ?? 'ANY'} onValueChange={(v) => { field.onChange(v); if (v === 'QUORUM' && !step?.requiredCount) setValue(`steps.${i}.requiredCount`, 2); if (v !== 'QUORUM') setValue(`steps.${i}.requiredCount`, undefined); }}>
              <SelectTrigger id={`wf-step-${i}-mode`}><SelectValue /></SelectTrigger>
              <SelectContent>{APPROVAL_STEP_MODES.map((m) => <SelectItem key={m} value={m}>{t(`workflows.modeLabel.${m}`)}</SelectItem>)}</SelectContent>
            </Select>
          )} />
        </FormField>
        {step?.mode === 'QUORUM' ? (
          <FormField label={t('workflows.requiredCount')} htmlFor={`wf-step-${i}-quorum`} error={requiredCountError}>
            <Controller control={control} name={`steps.${i}.requiredCount`} render={({ field }) => <Input id={`wf-step-${i}-quorum`} type="number" min={1} max={50} value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value === '' ? undefined : Number(e.target.value))} />} />
          </FormField>
        ) : <div className="hidden sm:block" />}
        <FormField label={t('workflows.escalation')} htmlFor={`wf-step-${i}-esc`} error={errors?.escalateTo?.message}>
          <Controller control={control} name={`steps.${i}.escalateTo`} render={({ field }) => (
            <Select value={field.value ?? 'NONE'} onValueChange={(v) => { if (v === 'NONE') { field.onChange(undefined); setValue(`steps.${i}.escalateAfterHours`, undefined); } else { field.onChange(v); if (!step?.escalateAfterHours) setValue(`steps.${i}.escalateAfterHours`, 48); } }}>
              <SelectTrigger id={`wf-step-${i}-esc`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">{t('workflows.noEscalation')}</SelectItem>
                {APPROVAL_ESCALATION_TARGETS.map((e) => <SelectItem key={e} value={e}>{t(`workflows.escalateTarget.${e}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          )} />
        </FormField>
        {step?.escalateTo ? (
          <FormField label={t('workflows.escalateAfterHours')} htmlFor={`wf-step-${i}-esc-hours`} error={errors?.escalateAfterHours?.message}>
            <Controller control={control} name={`steps.${i}.escalateAfterHours`} render={({ field }) => <Input id={`wf-step-${i}-esc-hours`} type="number" min={1} max={720} value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value === '' ? undefined : Number(e.target.value))} />} />
          </FormField>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Approval workflow editor v2: request type, branch, tier (from N units), applies-to narrowing and up to 5 levels —
 * manager, secondary manager, manager chain (N levels up), HR admins, department head, branch manager, a role or a
 * permission, a named user — each with a decision mode (any / all / quorum) and an optional escalation after N hours.
 * There is no self-approval switch: the person a request is about never decides it (review P0-3).
 */
export function WorkflowDialog({ open, onOpenChange, workflow }: { open: boolean; onOpenChange: (o: boolean) => void; workflow: WorkflowDto | null }) {
  const { t } = useTranslation('approvals');
  const { t: tc } = useTranslation();
  const { create, update } = useWorkflowMutations();
  const branches = useBranchOptions();
  const departments = useDepartmentOptions();
  const roles = useRoles();
  const [memberSearch, setMemberSearch] = useState('');
  const members = useMembers({ search: memberSearch || undefined, pageSize: 20, sort: 'fullName', status: 'active' });
  const roleOptions = useMemo(() => (roles.data ?? []).map((r) => ({ value: r.id, label: r.name, description: r.isSystem ? t('workflows.systemRole') : undefined })), [roles.data, t]);
  const memberOptions = useMemo(() => (members.data?.data ?? []).map((m) => ({ value: m.userId, label: m.fullName || m.email, description: m.email })), [members.data]);
  const form = useForm<FormValues, unknown, ApprovalWorkflowInput>({ resolver: zodResolver(approvalWorkflowInputSchema), defaultValues: toDefaults(workflow) });
  const { register, control, formState: { errors, isSubmitting }, setValue, getValues } = form;
  const steps = useFieldArray({ control, name: 'steps' });
  const renumber = () => getValues('steps').forEach((_s, i) => setValue(`steps.${i}.order`, i + 1));
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload: ApprovalWorkflowInput = { ...values, steps: values.steps.map((s, i) => cleanStep(s, i)) as ApprovalWorkflowInput['steps'], appliesTo: { ...(values.appliesTo.branchIds?.length ? { branchIds: values.appliesTo.branchIds } : {}), ...(values.appliesTo.departmentIds?.length ? { departmentIds: values.appliesTo.departmentIds } : {}) } };
      if (workflow) { await update.mutateAsync({ id: workflow.id, input: payload }); toast.success(t('workflows.updated')); }
      else { await create.mutateAsync(payload); toast.success(t('workflows.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });
  const stepErrors = Array.isArray(errors.steps) ? errors.steps : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[92vh] overflow-y-auto">
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
            <FormField label={t('workflows.minUnits')} htmlFor="wf-min-units" optional hint={t('workflows.minUnitsHint')} error={errors.minUnits?.message}>
              <Controller control={control} name="minUnits" render={({ field }) => <Input id="wf-min-units" type="number" min={0} step="0.5" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value === '' ? null : Number(e.target.value))} />} />
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
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">{t('workflows.appliesTo')}</legend>
            <p className="text-xs text-muted-foreground">{t('workflows.appliesHint')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('workflows.appliesBranches')} htmlFor="wf-applies-branches" optional>
                <Controller control={control} name="appliesTo" render={({ field }) => <ChipPicker id="wf-applies-branches" values={field.value?.branchIds ?? []} onChange={(next) => field.onChange({ ...(field.value ?? {}), branchIds: next })} options={branches.options} placeholder={t('workflows.allBranches')} />} />
              </FormField>
              <FormField label={t('workflows.appliesDepartments')} htmlFor="wf-applies-departments" optional>
                <Controller control={control} name="appliesTo" render={({ field }) => <ChipPicker id="wf-applies-departments" values={field.value?.departmentIds ?? []} onChange={(next) => field.onChange({ ...(field.value ?? {}), departmentIds: next })} options={departments.options} placeholder="—" />} />
              </FormField>
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Controller control={control} name="isDefault" render={({ field }) => (
              <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                <div><Label htmlFor="wf-default">{t('workflows.isDefault')}</Label><p className="text-xs text-muted-foreground">{t('workflows.isDefaultHint')}</p></div>
                <Switch id="wf-default" checked={field.value ?? true} onCheckedChange={field.onChange} />
              </div>
            )} />
          </div>

          <section className="space-y-2">
            <div className="flex items-center justify-between"><h4 className="text-sm font-semibold">{t('workflows.steps')}</h4><span className="text-xs text-muted-foreground">{t('workflows.stepsCount', { count: steps.fields.length, max: MAX_STEPS })}</span></div>
            {typeof errors.steps?.message === 'string' ? <p className="text-xs text-destructive" role="alert">{errors.steps.message}</p> : null}
            <ol className="space-y-2">
              {steps.fields.map((fld, i) => (
                <StepEditor key={fld.id} i={i} control={control} count={steps.fields.length} errors={stepErrors[i] as Partial<Record<keyof StepValues, { message?: string }>> | undefined}
                  onMove={(from, to) => { steps.swap(from, to); renumber(); }} onRemove={() => { steps.remove(i); renumber(); }}
                  setValue={(name, value) => setValue(name as never, value as never)} roleOptions={roleOptions} memberOptions={memberOptions} onMemberSearch={setMemberSearch} loading={{ roles: roles.isLoading, members: members.isLoading }} />
              ))}
            </ol>
            <Button type="button" variant="outline" size="sm" disabled={steps.fields.length >= MAX_STEPS} onClick={() => steps.append({ order: steps.fields.length + 1, approverType: 'HR_ADMIN', mode: 'ANY' })}><Plus /> {t('workflows.addStep')}</Button>
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
