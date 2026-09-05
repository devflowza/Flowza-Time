import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { ASSIGNMENT_TARGETS, shiftAssignmentInputSchema, type ShiftAssignmentInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { useTeams } from '@/features/organization/api';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { useEmployeeOptions } from '@/features/employees/api';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useAssignmentMutations, usePatterns, useShiftOptions } from '../api';

type FormValues = z.input<typeof shiftAssignmentInputSchema>;
type Mode = 'shift' | 'pattern';

/** Assign a shift or a rotational pattern to an organisation / branch / department / team / employee for an effective range. */
export function AssignmentDialog({ open, onOpenChange, preset }: { open: boolean; onOpenChange: (o: boolean) => void; preset?: Partial<FormValues> }) {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const orgId = useOrgId();
  const navigate = useNavigate();
  const { create } = useAssignmentMutations();
  const shifts = useShiftOptions();
  const patterns = usePatterns();
  const branches = useBranchOptions();
  const departments = useDepartmentOptions();
  const teams = useTeams({ pageSize: 200, sort: 'name', status: 'active' });
  const employees = useEmployeeOptions();
  const [mode, setMode] = useState<Mode>(preset?.shiftPatternId ? 'pattern' : 'shift');
  const form = useForm<FormValues, unknown, ShiftAssignmentInput>({ resolver: zodResolver(shiftAssignmentInputSchema), defaultValues: { targetType: 'EMPLOYEE', targetId: '', effectiveFrom: todayIso(tz), effectiveTo: null, ...preset } });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const targetType = useWatch({ control, name: 'targetType' }) ?? 'EMPLOYEE';
  const targetOptions = useMemo(() => {
    switch (targetType) {
      case 'BRANCH': return { options: branches.options, loading: branches.isLoading, search: undefined };
      case 'DEPARTMENT': return { options: departments.options, loading: departments.isLoading, search: undefined };
      case 'TEAM': return { options: (teams.data?.data ?? []).map((tm) => ({ value: tm.id, label: tm.name, description: tm.branchName ?? tm.code })), loading: teams.isLoading, search: undefined };
      case 'EMPLOYEE': return { options: employees.options, loading: employees.isLoading, search: employees.setSearch };
      default: return { options: [], loading: false, search: undefined };
    }
  }, [targetType, branches, departments, teams.data, teams.isLoading, employees]);
  const patternOptions = useMemo(() => (patterns.data ?? []).map((p) => ({ value: p.id, label: p.name, description: t('patterns.cycleDays', { count: p.cycleLengthDays }) })), [patterns.data, t]);
  const rootError = (errors as Record<string, { message?: string } | undefined>)['']?.message ?? (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const res = await create.mutateAsync({ ...values, effectiveTo: values.effectiveTo || null, shiftId: mode === 'shift' ? values.shiftId : undefined, shiftPatternId: mode === 'pattern' ? values.shiftPatternId : undefined });
      if (res.recalculationJobId) toastJobQueued(res.recalculationJobId, navigate, t('assignments.recalcHint'), { to: '/attendance?tab=recalc' }); else toast.success(t('assignments.created'));
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('assignments.add')}</DialogTitle><DialogDescription>{t('assignments.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('assignments.targetType')} htmlFor="as-ttype" required error={errors.targetType?.message}>
              <Controller control={control} name="targetType" render={({ field }) => (
                <Select value={field.value ?? 'EMPLOYEE'} onValueChange={(v) => { field.onChange(v); setValue('targetId', v === 'ORGANIZATION' ? orgId : ''); }}>
                  <SelectTrigger id="as-ttype"><SelectValue /></SelectTrigger>
                  <SelectContent>{ASSIGNMENT_TARGETS.map((s) => <SelectItem key={s} value={s}>{t(`assignments.targets.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label={t('assignments.target')} htmlFor="as-target" required error={errors.targetId?.message}>
              {targetType === 'ORGANIZATION' ? <Input id="as-target" value={t('assignments.wholeOrganisation')} readOnly /> : (
                <Controller control={control} name="targetId" render={({ field }) => <Combobox id="as-target" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} options={targetOptions.options} onSearch={targetOptions.search} loading={targetOptions.loading} placeholder={t('assignments.selectTarget')} aria-invalid={!!errors.targetId} />} />
              )}
            </FormField>
          </div>
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex gap-1 rounded-md bg-muted p-0.5" role="tablist" aria-label={t('assignments.mode')}>
              {(['shift', 'pattern'] as Mode[]).map((m) => <button key={m} type="button" role="tab" aria-selected={mode === m} className={`flex-1 rounded px-3 py-1 text-sm ${mode === m ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground'}`} onClick={() => setMode(m)}>{t(`assignments.modes.${m}`)}</button>)}
            </div>
            {mode === 'shift' ? (
              <FormField label={t('assignments.shift')} htmlFor="as-shift" required error={errors.shiftId?.message ?? rootError}>
                <Controller control={control} name="shiftId" render={({ field }) => <Combobox id="as-shift" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={shifts.options} loading={shifts.isLoading} placeholder={t('assignments.selectShift')} aria-invalid={!!errors.shiftId || !!rootError} />} />
              </FormField>
            ) : (
              <FormField label={t('assignments.pattern')} htmlFor="as-pattern" required error={errors.shiftPatternId?.message ?? rootError}>
                <Controller control={control} name="shiftPatternId" render={({ field }) => <Combobox id="as-pattern" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={patternOptions} loading={patterns.isLoading} placeholder={t('assignments.selectPattern')} emptyText={t('patterns.empty')} aria-invalid={!!errors.shiftPatternId || !!rootError} />} />
              </FormField>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('assignments.effectiveFrom')} htmlFor="as-from" required error={errors.effectiveFrom?.message} hint={t('assignments.effectiveFromHint')}><Input id="as-from" type="date" dir="ltr" {...register('effectiveFrom')} aria-invalid={!!errors.effectiveFrom} /></FormField>
            <FormField label={t('assignments.effectiveTo')} htmlFor="as-to" optional error={errors.effectiveTo?.message}><Input id="as-to" type="date" dir="ltr" {...register('effectiveTo', { setValueAs: (v: unknown) => (v === '' ? null : v) })} /></FormField>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{t('assignments.assign')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
