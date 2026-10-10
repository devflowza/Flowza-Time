import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocationDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField } from '@/components/ui';
import { useLocationMutations } from '@/features/locations/api';
import { LocationPicker } from '@/features/locations/components/location-picker';
import { LOCATIONS_NS } from '@/features/locations/locale';
import { canBeParentOf, subtreeOf } from '@/features/locations/rules';
import type { LocationTree } from '@/features/locations/use-location-tree';
import { ApiError } from '@/lib/api-client';
import { toast, toastError } from '@/lib/toast';
import { Callout } from './callout';

/**
 * Move a node under another parent (PATCH locations/:id { parentId }); everything below it moves along. The picker offers
 * only valid parents: a group node or the top for a group, a group node or the top for a branch ("Place under…"), a branch
 * or a place on a higher level for a place. A place moving to another branch is refused (409) while something there refers
 * to it — said before and explained after.
 */
export function MoveLocationDialog({ node, tree, onClose }: { node: LocationDto; tree: LocationTree; onClose: () => void }) {
  const { t } = useTranslation(LOCATIONS_NS);
  const { t: tc } = useTranslation();
  const { update } = useLocationMutations();
  const [parentId, setParentId] = useState<string | null>(node.parentId);
  const [error, setError] = useState<string | null>(null);
  const subtree = useMemo(() => subtreeOf(tree, node.id), [tree, node.id]);
  const filter = useCallback((c: LocationDto) => canBeParentOf(tree, node, c, subtree), [tree, node, subtree]);
  const name = tree.nameOf(node);
  const isBranch = node.role === 'branch';
  const canBeTop = node.role !== 'place';
  const target = parentId ? tree.byId.get(parentId) : undefined;
  const crossBranch = node.role === 'place' && !!target && target.branchId !== node.branchId;
  const changed = parentId !== node.parentId && (canBeTop || parentId !== null);

  const submit = () => {
    setError(null);
    update.mutate({ id: node.id, input: { parentId } }, {
      onSuccess: () => { toast.success(isBranch ? t('move.placed', { name }) : t('move.moved', { name })); onClose(); },
      onError: (e) => {
        // 409: a place's references keep it in its branch; 400 / 422: a placement rule the server checked (said in its words)
        if (e instanceof ApiError && e.status === 409) setError(node.role === 'place' ? t('move.refused') : e.message);
        else if (e instanceof ApiError && (e.status === 400 || e.status === 422)) setError(e.message);
        else toastError(e);
      },
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isBranch ? t('move.placeTitle', { name }) : t('move.title', { name })}</DialogTitle>
          <DialogDescription>{isBranch ? t('move.placeHint') : t('move.hint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{node.parentId ? t('move.current', { path: tree.labelOf(node.parentId) }) : t('move.currentTop')}</p>
          <FormField label={t('move.newParent')} htmlFor="loc-move-parent" required={!canBeTop}>
            <LocationPicker
              id="loc-move-parent" value={parentId} onChange={(v) => { setParentId(v); setError(null); }}
              roles={node.role === 'place' ? ['branch', 'place'] : ['group']} filter={filter} clearable={canBeTop}
              placeholder={canBeTop ? t('move.topLevel') : t('move.choose')} emptyText={t('move.noTargets')}
            />
          </FormField>
          {crossBranch ? <Callout data-testid="move-cross-branch">{t('move.crossBranch')}</Callout> : null}
          {error ? <Callout tone="error">{error}</Callout> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={submit} loading={update.isPending} disabled={!changed}>{t('move.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
