import { useMemo } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { LOCATION_LEVEL_ICONS, type LocationLevelDto, type LocationLevelIcon, type LocationLevelRole } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { useLocationLevelMutations } from '@/features/locations/api';
import { LOCATIONS_NS } from '@/features/locations/locale';
import { levelInsertionPoints, roleForNewLevel, type LevelInsertionPoint } from '@/features/locations/rules';
import type { LocationTree } from '@/features/locations/use-location-tree';
import { toast, toastError } from '@/lib/toast';
import { Callout } from './callout';
import { IconPicker } from './icon-picker';

/** `create` inserts a level at `position` (1 … n + 1, the levels from there down move one place); `rename` edits one. */
export type LevelDialogState = { mode: 'create'; position: number } | { mode: 'rename'; level: LocationLevelDto };

/** location_levels.name / name_ar: 1–60 characters (the inputs cap the length, so only "required" can be reported). */
const NAME_MAX = 60;

const levelFormSchema = (t: TFunction) => z.object({
  name: z.string().trim().min(1, t('levelDialog.nameRequired')).max(NAME_MAX),
  nameAr: z.string().trim().max(NAME_MAX),
  icon: z.enum(LOCATION_LEVEL_ICONS),
  position: z.number().int().min(1),
});
type LevelFormValues = z.infer<ReturnType<typeof levelFormSchema>>;

/** A sensible first icon for a new level: a head office / region above the branches, a site / zone inside them. */
function defaultIcon(role: 'group' | 'place', levels: readonly LocationLevelDto[]): LocationLevelIcon {
  if (role === 'group') return levels.some((l) => l.role === 'group') ? 'region' : 'headquarters';
  return levels.some((l) => l.role === 'place') ? 'zone' : 'site';
}

/** What the role of a level means, in one sentence (the dialog says which one a new level gets before it is created). */
export function RoleNote({ role, branchName }: { role: LocationLevelRole; branchName: string }) {
  const { t } = useTranslation(LOCATIONS_NS);
  return (
    <Callout data-testid="level-role-note">
      <span className="font-medium">{t(`roles.${role}`)}.</span> {t(`roleNotes.${role}`, { branch: branchName })}
    </Callout>
  );
}

export function LevelDialog({ state, tree, onClose }: { state: LevelDialogState; tree: LocationTree; onClose: () => void }) {
  const { t } = useTranslation(LOCATIONS_NS);
  const { t: tc } = useTranslation();
  const { create, update } = useLocationLevelMutations();
  const schema = useMemo(() => levelFormSchema(t), [t]);
  const points = useMemo(() => levelInsertionPoints(tree.levels), [tree.levels]);
  const editing = state.mode === 'rename' ? state.level : null;
  const form = useForm<LevelFormValues>({
    resolver: zodResolver(schema),
    defaultValues: editing
      ? { name: editing.name, nameAr: editing.nameAr ?? '', icon: editing.icon, position: editing.position }
      : { name: '', nameAr: '', icon: defaultIcon(roleForNewLevel(tree.levels, state.mode === 'create' ? state.position : 1), tree.levels), position: state.mode === 'create' ? state.position : 1 },
  });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const position = useWatch({ control, name: 'position' });
  const role: LocationLevelRole = editing ? editing.role : roleForNewLevel(tree.levels, position);
  const branchName = tree.levelName(tree.branchLevel);

  const pointLabel = (p: LevelInsertionPoint) => p.above && p.below
    ? t('levelDialog.positionBetween', { above: tree.levelName(p.above), below: tree.levelName(p.below) })
    : p.below ? t('levelDialog.positionTop', { below: tree.levelName(p.below) }) : t('levelDialog.positionBottom', { above: tree.levelName(p.above) });

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, input: { name: v.name, nameAr: v.nameAr || null, icon: v.icon } });
        toast.success(t('levels.updated'));
      } else {
        await create.mutateAsync({ name: v.name, ...(v.nameAr ? { nameAr: v.nameAr } : {}), icon: v.icon, position: v.position });
        toast.success(t('levels.created'));
      }
      onClose();
    } catch (e) { toastError(e); }
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? t('levelDialog.renameTitle', { name: tree.levelName(editing) }) : t('levelDialog.addTitle')}</DialogTitle>
          <DialogDescription>{editing ? t('levelDialog.renameHint') : t('levelDialog.addHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {editing ? null : (
            <FormField label={t('levelDialog.position')} htmlFor="lv-position" required>
              <Controller control={control} name="position" render={({ field }) => (
                <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                  <SelectTrigger id="lv-position"><SelectValue /></SelectTrigger>
                  <SelectContent>{points.map((p) => <SelectItem key={p.position} value={String(p.position)}>{pointLabel(p)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
          )}
          <RoleNote role={role} branchName={branchName} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('levelDialog.name')} htmlFor="lv-name" required error={errors.name?.message}>
              <Input id="lv-name" maxLength={NAME_MAX} autoComplete="off" {...register('name')} aria-invalid={!!errors.name} />
            </FormField>
            <FormField label={t('levelDialog.nameAr')} htmlFor="lv-nameAr" optional>
              <Input id="lv-nameAr" dir="rtl" maxLength={NAME_MAX} autoComplete="off" {...register('nameAr')} />
            </FormField>
          </div>
          <Controller control={control} name="icon" render={({ field }) => <IconPicker value={field.value} onChange={field.onChange} legend={t('levelDialog.icon')} />} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{editing ? tc('common.save') : t('levels.add')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
