import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { teamInputSchema, type TeamDto } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useEmployeeOptions } from '@/features/employees/api';
import { useStructureMutations, useTeam } from '../api';
import { useBranchOptions } from '../lookups';

type FormValues = z.input<typeof teamInputSchema>;
type Output = z.output<typeof teamInputSchema>;

export function TeamDialog({ open, onOpenChange, team }: { open: boolean; onOpenChange: (o: boolean) => void; team: TeamDto | null }) {
  const detail = useTeam(team?.id ?? null);
  if (team && !detail.data) return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><Skeleton className="h-6 w-40" /><Skeleton className="h-48 w-full" /></DialogContent></Dialog>;
  return <TeamForm key={detail.data?.updatedAt ?? 'new'} open={open} onOpenChange={onOpenChange} team={detail.data ?? null} />;
}

function TeamForm({ open, onOpenChange, team }: { open: boolean; onOpenChange: (o: boolean) => void; team: TeamDto | null }) {
  const { t } = useTranslation('organization');
  const { t: tc } = useTranslation();
  const { create, update } = useStructureMutations<TeamDto, Output>('teams');
  const branches = useBranchOptions();
  const employees = useEmployeeOptions();
  const form = useForm<FormValues, unknown, Output>({
    resolver: zodResolver(teamInputSchema),
    defaultValues: team ? { code: team.code, name: team.name, branchId: team.branchId, leadEmployeeId: team.leadEmployeeId, memberIds: (team.members ?? []).map((m) => m.employeeId) } : { code: '', name: '', branchId: null, leadEmployeeId: null, memberIds: [] },
  });
  const { register, control, formState: { errors, isSubmitting }, watch, setValue } = form;
  const memberIds = watch('memberIds') ?? [];
  const knownNames = new Map<string, string>((team?.members ?? []).map((m) => [m.employeeId, `${m.displayName} · ${m.employeeNumber}`]));
  for (const o of employees.options) knownNames.set(o.value, o.label);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (team) { await update.mutateAsync({ id: team.id, input: values }); toast.success(t('teams.updated')); }
      else { await create.mutateAsync(values); toast.success(t('teams.created')); }
      onOpenChange(false);
    } catch (e) { toastError(e); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{team ? t('teams.edit') : t('teams.add')}</DialogTitle>
          <DialogDescription>{t('teams.dialogHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.code')} htmlFor="tm-code" required error={errors.code?.message}>
              <Input id="tm-code" dir="ltr" {...register('code')} aria-invalid={!!errors.code} />
            </FormField>
            <FormField label={tc('common.name')} htmlFor="tm-name" required error={errors.name?.message}>
              <Input id="tm-name" {...register('name')} aria-invalid={!!errors.name} />
            </FormField>
          </div>
          <FormField label={tc('common.branch')} htmlFor="tm-branch" optional>
            <Controller control={control} name="branchId" render={({ field }) => <Combobox id="tm-branch" value={field.value} onChange={field.onChange} options={branches.options} loading={branches.isLoading} clearable placeholder={t('departments.allBranches')} />} />
          </FormField>
          <FormField label={t('teams.lead')} htmlFor="tm-lead" optional>
            <Controller control={control} name="leadEmployeeId" render={({ field }) => <Combobox id="tm-lead" value={field.value} onChange={field.onChange} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={tc('common.none')} />} />
          </FormField>
          <FormField label={t('teams.members')} htmlFor="tm-members" hint={t('teams.membersHint')} error={errors.memberIds?.message}>
            <Combobox id="tm-members" value={null} onChange={(v) => { if (v && !memberIds.includes(v)) setValue('memberIds', [...memberIds, v], { shouldDirty: true }); }} options={employees.options.filter((o) => !memberIds.includes(o.value))} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('teams.addMember')} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {memberIds.length === 0 ? <span className="text-xs text-muted-foreground">{t('teams.noMembers')}</span> : null}
              {memberIds.map((id) => (
                <Badge key={id} variant="secondary" className="gap-1 pe-1">
                  {knownNames.get(id) ?? id.slice(0, 8)}
                  <button type="button" className="rounded-full p-0.5 hover:bg-background" aria-label={t('teams.removeMember')} onClick={() => setValue('memberIds', memberIds.filter((m) => m !== id), { shouldDirty: true })}><X className="size-3" /></button>
                </Badge>
              ))}
            </div>
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{team ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
