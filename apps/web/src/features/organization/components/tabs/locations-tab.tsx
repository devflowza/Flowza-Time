import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, ErrorState, Skeleton } from '@/components/ui';
import { useOrgTimezone } from '@/features/me/use-me';
import { LOCATIONS_NS } from '@/features/locations/locale';
import { useLocationTree } from '@/features/locations/use-location-tree';
import { useBranch } from '../../api';
import { BranchDialog } from '../branch-dialog';
import { LevelsPanel } from '../locations/levels-panel';
import { LocationTreePanel } from '../locations/location-tree-panel';
import { useLocationAccess } from '../locations/use-location-access';

/** The branch dialog for a branch node of the tree, which carries the branch's id only: the record is loaded first. */
function BranchEditor({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const { t } = useTranslation('organization');
  const { t: tl } = useTranslation(LOCATIONS_NS);
  const tz = useOrgTimezone();
  const q = useBranch(branchId);
  if (q.data) return <BranchDialog open onOpenChange={(o) => { if (!o) onClose(); }} branch={q.data} orgTimezone={tz} />;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('branches.edit')}</DialogTitle>
          <DialogDescription>{tl('branchEditor.loading')}</DialogDescription>
        </DialogHeader>
        {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Organisation → Locations (docs/locations.md): the organisation's levels (names, templates) and its location tree (groups,
 * branches, places). Branch records stay in the Branches tab; here a branch is placed in the tree and opened for editing.
 */
export function LocationsTab() {
  const [showArchived, setShowArchived] = useState(false);
  const tree = useLocationTree({ includeArchived: showArchived });
  const access = useLocationAccess();
  const tz = useOrgTimezone();
  const [editingBranch, setEditingBranch] = useState<string | null>(null);
  const [addingBranchUnder, setAddingBranchUnder] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <LevelsPanel tree={tree} access={access} />
      <LocationTreePanel
        tree={tree} access={access} showArchived={showArchived} onShowArchivedChange={setShowArchived}
        onEditBranch={setEditingBranch} onAddBranch={setAddingBranchUnder}
      />
      {editingBranch ? <BranchEditor key={editingBranch} branchId={editingBranch} onClose={() => setEditingBranch(null)} /> : null}
      {addingBranchUnder ? (
        <BranchDialog key={addingBranchUnder} open onOpenChange={(o) => { if (!o) setAddingBranchUnder(null); }} branch={null} orgTimezone={tz} defaultParentLocationId={addingBranchUnder} />
      ) : null}
    </div>
  );
}
