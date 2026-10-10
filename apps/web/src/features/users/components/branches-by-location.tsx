import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListPlus } from 'lucide-react';
import { Button, Label } from '@/components/ui';
import { toast } from '@/lib/toast';
import { LocationPicker } from '@/features/locations/components/location-picker';
import { useLocationTree, type LocationTree } from '@/features/locations/use-location-tree';
import { depthFirst } from '@/features/locations/tree';

/** A region (any group level) or a single branch. */
const SCOPE_ROLES = ['group', 'branch'] as const;

/** The branches under a node: the branch itself for a branch node, every branch node of the subtree for a group node. */
function branchesUnder(tree: LocationTree, nodeId: string): string[] {
  const node = tree.byId.get(nodeId);
  if (!node) return [];
  const nodes = [node, ...depthFirst(tree, node.id).map((r) => r.node)];
  return [...new Set(nodes.flatMap((n) => (n.role === 'branch' && n.branchId ? [n.branchId] : [])))];
}

interface BranchesByLocationProps {
  id: string;
  /** The branches already chosen. */
  selected: readonly string[];
  /** The branches the dialog offers: only these are ever added (what the caller could tick by hand). */
  available: readonly string[];
  onAdd: (branchIds: string[]) => void;
  disabled?: boolean;
}

/**
 * "Add branches by location" for a member's / an invitation's branch scope (docs/locations.md §2): pick a region (or a branch)
 * and every branch under it is added to the selection. The scope is stored as explicit branches — a branch placed under the
 * region later is not included, which the note says. Shown only when the organisation has group levels above its branches.
 */
export function BranchesByLocation({ id, selected, available, onAdd, disabled }: BranchesByLocationProps) {
  const { t } = useTranslation('users');
  const tree = useLocationTree();
  const [nodeId, setNodeId] = useState<string | null>(null);
  if (!tree.hasGroupLevels) return null;

  const offered = new Set(available);
  const toAdd = nodeId ? branchesUnder(tree, nodeId).filter((b) => offered.has(b) && !selected.includes(b)) : [];
  const add = () => {
    const node = nodeId ? tree.byId.get(nodeId) : undefined;
    onAdd(toAdd);
    toast.success(t('fields.byLocationAdded', { count: toAdd.length, name: node ? tree.nameOf(node) : '' }));
    setNodeId(null);
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3" data-testid="branches-by-location">
      <Label htmlFor={id}>{t('fields.byLocation')}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <LocationPicker id={id} value={nodeId} roles={SCOPE_ROLES} onChange={(v) => setNodeId(v)} placeholder={t('fields.byLocationPlaceholder')} disabled={disabled} />
        </div>
        <Button type="button" size="sm" variant="outline" disabled={disabled || toAdd.length === 0} onClick={add}>
          <ListPlus /> {nodeId ? t('fields.byLocationAdd', { count: toAdd.length }) : t('fields.byLocationIdle')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('fields.byLocationNote')}</p>
    </div>
  );
}
