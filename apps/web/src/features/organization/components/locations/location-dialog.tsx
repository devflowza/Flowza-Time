import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { LocationDto, LocationInput, UpdateLocationInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { useLocationMutations } from '@/features/locations/api';
import { LevelIcon } from '@/features/locations/components/level-icon';
import { LOCATIONS_NS } from '@/features/locations/locale';
import { childLevelsFor, relevelOptions } from '@/features/locations/rules';
import type { LocationTree } from '@/features/locations/use-location-tree';
import { ApiError } from '@/lib/api-client';
import { toast, toastError } from '@/lib/toast';

/** `add` creates a group / place node under `parent` (null = the top of the tree); `edit` renames / re-levels / re-codes one. */
export type LocationDialogState = { mode: 'add'; parent: LocationDto | null } | { mode: 'edit'; node: LocationDto };

// the database's limits (locations.code / name / name_ar); the inputs cap the length so only actionable messages remain
const CODE_MAX = 32;
const NAME_MAX = 120;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const coordinate = (limit: number, message: string) => z.string().trim().refine((v) => v === '' || (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= limit), message);

const locationFormSchema = (t: TFunction, codeRequired: boolean) => z.object({
  levelId: z.string().min(1, t('locationDialog.levelRequired')),
  code: z.string().trim().max(CODE_MAX)
    .refine((v) => !codeRequired || v !== '', t('locationDialog.codeRequired'))
    .refine((v) => v === '' || CODE_RE.test(v), t('locationDialog.codeInvalid')),
  name: z.string().trim().min(1, t('locationDialog.nameRequired')).max(NAME_MAX),
  nameAr: z.string().trim().max(NAME_MAX),
  latitude: coordinate(90, t('locationDialog.latitudeRange')),
  longitude: coordinate(180, t('locationDialog.longitudeRange')),
}).superRefine((v, ctx) => {
  if ((v.latitude === '') !== (v.longitude === '')) ctx.addIssue({ code: 'custom', path: [v.latitude === '' ? 'latitude' : 'longitude'], message: t('locationDialog.pointBoth') });
});
type LocationFormValues = z.infer<ReturnType<typeof locationFormSchema>>;

const toNumberOrNull = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const fromNumber = (v: number | null): string => (v === null ? '' : String(v));

/**
 * Add or edit a group / place location (docs/locations.md §5, POST / PATCH locations). The level select only offers the
 * levels a node may use where it is — deeper than its parent, groups under groups, places under a branch or a place, and
 * when editing, above everything below it. Moving is a separate action (MoveLocationDialog); branch nodes are edited as
 * branches.
 */
export function LocationDialog({ state, tree, onClose }: { state: LocationDialogState; tree: LocationTree; onClose: () => void }) {
  const { t } = useTranslation(LOCATIONS_NS);
  const { t: tc } = useTranslation();
  const { create, update } = useLocationMutations();
  const node = state.mode === 'edit' ? state.node : null;
  const parent = state.mode === 'add' ? state.parent : (node?.parentId ? tree.byId.get(node.parentId) ?? null : null);
  const levels = useMemo(() => (node ? relevelOptions(tree, node) : childLevelsFor(tree, parent)), [tree, node, parent]);
  const schema = useMemo(() => locationFormSchema(t, !!node), [t, node]);
  const form = useForm<LocationFormValues>({
    resolver: zodResolver(schema),
    defaultValues: node
      ? { levelId: node.levelId, code: node.code, name: node.name, nameAr: node.nameAr ?? '', latitude: fromNumber(node.latitude), longitude: fromNumber(node.longitude) }
      : { levelId: levels[0]?.id ?? '', code: '', name: '', nameAr: '', latitude: '', longitude: '' },
  });
  const { register, control, setError, formState: { errors, isSubmitting } } = form;
  const parentLabel = parent ? tree.labelOf(parent.id) : t('locationDialog.topLevel');

  const onSubmit = form.handleSubmit(async (v) => {
    const latitude = toNumberOrNull(v.latitude);
    const longitude = toNumberOrNull(v.longitude);
    try {
      if (node) {
        const input: UpdateLocationInput = {};
        if (v.levelId !== node.levelId) input.levelId = v.levelId;
        if (v.code !== node.code) input.code = v.code;
        if (v.name !== node.name) input.name = v.name;
        if ((v.nameAr || null) !== node.nameAr) input.nameAr = v.nameAr || null;
        // the two coordinates travel together (updateLocationSchema)
        if (latitude !== node.latitude || longitude !== node.longitude) { input.latitude = latitude; input.longitude = longitude; }
        if (Object.keys(input).length > 0) await update.mutateAsync({ id: node.id, input });
        toast.success(t('locationDialog.updated', { name: v.name }));
      } else {
        const input: LocationInput = {
          levelId: v.levelId, parentId: parent?.id ?? null, name: v.name,
          ...(v.code ? { code: v.code } : {}), ...(v.nameAr ? { nameAr: v.nameAr } : {}),
          ...(latitude !== null && longitude !== null ? { latitude, longitude } : {}),
        };
        await create.mutateAsync(input);
        toast.success(t('locationDialog.created', { name: v.name }));
      }
      onClose();
    } catch (e) {
      // two siblings cannot share a code (locations_sibling_code_key): say so on the field
      if (e instanceof ApiError && e.status === 409 && (v.code !== '' || String(e.details?.['constraint'] ?? '').includes('code'))) setError('code', { message: t('locationDialog.codeTaken') });
      else toastError(e);
    }
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{node ? t('locationDialog.editTitle', { name: tree.nameOf(node) }) : parent ? t('locationDialog.addUnder', { parent: tree.nameOf(parent) }) : t('locationDialog.addTop')}</DialogTitle>
          <DialogDescription>{node ? t('locationDialog.editHint') : t('locationDialog.addHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <p className="text-sm"><span className="text-muted-foreground">{t('locationDialog.parent')}: </span><span className="font-medium">{parentLabel}</span></p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('locationDialog.level')} htmlFor="loc-level" required error={errors.levelId?.message} hint={levels.length > 1 ? t('locationDialog.levelHint') : undefined}>
              <Controller control={control} name="levelId" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={levels.length <= 1}>
                  <SelectTrigger id="loc-level" aria-invalid={!!errors.levelId}><SelectValue placeholder={t('locationDialog.levelPlaceholder')} /></SelectTrigger>
                  <SelectContent>
                    {levels.map((l) => (
                      <SelectItem key={l.id} value={l.id}><span className="inline-flex items-center gap-2"><LevelIcon icon={l.icon} className="text-muted-foreground" />{tree.levelName(l)}</span></SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label={t('locationDialog.code')} htmlFor="loc-code" required={!!node} optional={!node} error={errors.code?.message} hint={node ? t('locationDialog.codeEditHint') : t('locationDialog.codeHint')}>
              <Input id="loc-code" dir="ltr" maxLength={CODE_MAX} autoComplete="off" className="font-mono" {...register('code')} aria-invalid={!!errors.code} />
            </FormField>
            <FormField label={t('locationDialog.name')} htmlFor="loc-name" required error={errors.name?.message}>
              <Input id="loc-name" maxLength={NAME_MAX} autoComplete="off" {...register('name')} aria-invalid={!!errors.name} />
            </FormField>
            <FormField label={t('locationDialog.nameAr')} htmlFor="loc-nameAr" optional>
              <Input id="loc-nameAr" dir="rtl" maxLength={NAME_MAX} autoComplete="off" {...register('nameAr')} />
            </FormField>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">{t('locationDialog.point')}</legend>
            <p className="text-xs text-muted-foreground">{t('locationDialog.pointHint')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('locationDialog.latitude')} htmlFor="loc-lat" optional error={errors.latitude?.message}>
                <Input id="loc-lat" dir="ltr" type="number" step="any" inputMode="decimal" className="tnum" {...register('latitude')} aria-invalid={!!errors.latitude} />
              </FormField>
              <FormField label={t('locationDialog.longitude')} htmlFor="loc-lng" optional error={errors.longitude?.message}>
                <Input id="loc-lng" dir="ltr" type="number" step="any" inputMode="decimal" className="tnum" {...register('longitude')} aria-invalid={!!errors.longitude} />
              </FormField>
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting} disabled={levels.length === 0}>{node ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
