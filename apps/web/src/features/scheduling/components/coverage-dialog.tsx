import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ShiftCoverageDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useBranchOptions } from '@/features/organization/lookups';
import { useShiftOptions } from '@/features/schedule/api';
import { LocationPicker } from '@/features/locations/components/location-picker';
import { useLocationTree } from '@/features/locations/use-location-tree';
import { useCoverageMutations } from '../api';
import { SCHED_NS } from '../i18n';
import { WEEKDAYS } from '../model';

/**
 * Add a coverage target (branch, shift, optionally a place of the branch, weekdays, minimum head count) or edit one's weekdays /
 * minimum. A target on a place (site, floor, zone…) counts only the people working there (docs/locations.md); without one it
 * covers the whole branch. The place is offered when the organisation has place levels.
 */
export function CoverageDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (o: boolean) => void; target: ShiftCoverageDto | null }) {
  const { t } = useTranslation(SCHED_NS);
  const { t: tc } = useTranslation();
  const branches = useBranchOptions();
  const shifts = useShiftOptions();
  const tree = useLocationTree();
  const { create, update } = useCoverageMutations();
  const [branchId, setBranchId] = useState<string | null>(target?.branchId ?? null);
  const [shiftId, setShiftId] = useState<string | null>(target?.shiftId ?? null);
  const [locationId, setLocationId] = useState<string | null>(target?.locationId ?? null);
  const [weekdays, setWeekdays] = useState<number[]>(target?.weekdays ?? [...WEEKDAYS]);
  const [minHeadcount, setMinHeadcount] = useState(target?.minHeadcount ?? 1);
  const showLocation = tree.hasPlaceLevels || !!target?.locationId;
  const valid = !!branchId && !!shiftId && weekdays.length > 0 && Number.isInteger(minHeadcount) && minHeadcount >= 1;
  const toggle = (d: number) => setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort((a, b) => a - b)));
  // a place belongs to one branch: another branch clears it
  const pickBranch = (v: string | null) => { if (v !== branchId) setLocationId(null); setBranchId(v); };

  const onSave = () => {
    if (!valid || !branchId || !shiftId) return;
    const done = { onSuccess: () => { toast.success(target ? t('coverage.saved') : t('coverage.created')); onOpenChange(false); }, onError: toastError };
    // a PATCH sends only what it changes (no defaults re-applied server-side); the branch, shift and place name the target
    if (target) update.mutate({ id: target.id, input: { weekdays, minHeadcount } }, done);
    else create.mutate({ branchId, shiftId, locationId, weekdays, minHeadcount }, done);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{target ? t('coverage.edit') : t('coverage.add')}</DialogTitle><DialogDescription>{t('coverage.dialogHint')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={tc('common.branch')} htmlFor="cov-branch" required>
              <Combobox id="cov-branch" value={branchId} onChange={pickBranch} options={branches.options} loading={branches.isLoading} disabled={!!target} placeholder={tc('common.branch')} />
            </FormField>
            <FormField label={t('coverage.shift')} htmlFor="cov-shift" required>
              <Combobox id="cov-shift" value={shiftId} onChange={setShiftId} options={shifts.options} loading={shifts.isLoading} disabled={!!target} placeholder={t('coverage.shift')} />
            </FormField>
          </div>
          {showLocation ? (
            <FormField label={t('coverage.location')} htmlFor="cov-location" optional hint={t('coverage.locationHint')}>
              <LocationPicker id="cov-location" roles={['place']} branchId={branchId} value={locationId} onChange={(v) => setLocationId(v)} disabled={!!target} clearable={!target} includeArchived={!!target} placeholder={t('coverage.wholeBranch')} />
            </FormField>
          ) : null}
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t('coverage.weekdays')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d) => (
                <button key={d} type="button" aria-pressed={weekdays.includes(d)} onClick={() => toggle(d)}
                  className={cn('h-8 min-w-12 rounded-md border px-2 text-sm', weekdays.includes(d) ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-accent')}>
                  {t(`weekdays.${d}`)}
                </button>
              ))}
            </div>
            {weekdays.length === 0 ? <p role="alert" className="text-xs text-destructive">{t('coverage.weekdaysRequired')}</p> : null}
          </fieldset>
          <FormField label={t('coverage.minHeadcount')} htmlFor="cov-min" required hint={t('coverage.minHeadcountHint')}>
            <Input id="cov-min" type="number" min={1} max={10000} value={minHeadcount} onChange={(e) => setMinHeadcount(Number(e.target.value))} />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={onSave} disabled={!valid} loading={create.isPending || update.isPending}>{tc('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
