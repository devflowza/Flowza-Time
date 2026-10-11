import { useDeferredValue, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive, ArchiveRestore, Building2, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FolderInput, Fingerprint, ListTree, Pencil, Plus, Search, Users,
} from 'lucide-react';
import type { LocationDto } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, EmptyState, ErrorState, Input, Label, Skeleton, Switch } from '@/components/ui';
import { useLocationMutations } from '@/features/locations/api';
import { LevelIcon } from '@/features/locations/components/level-icon';
import { LOCATIONS_NS } from '@/features/locations/locale';
import { childLevelsFor, searchTree } from '@/features/locations/rules';
import type { LocationTree } from '@/features/locations/use-location-tree';
import { fmtNumber } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { RowActions, type RowAction } from '../row-actions';
import { ArchiveLocationDialog } from './archive-location-dialog';
import { LocationDialog, type LocationDialogState } from './location-dialog';
import { MoveLocationDialog } from './move-location-dialog';
import type { LocationAccess } from './use-location-access';

/** Up to this many locations the whole tree opens expanded; a bigger one opens with only its top level expanded. */
const AUTO_EXPAND_MAX = 200;

type TreeDialog = { kind: 'form'; state: LocationDialogState } | { kind: 'move'; node: LocationDto } | { kind: 'archive'; node: LocationDto };

const toggled = (set: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
};

export interface LocationTreePanelProps {
  tree: LocationTree;
  access: LocationAccess;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
  /** "Edit branch" on a branch node: the branch dialog (name, code and status are the branch's). */
  onEditBranch: (branchId: string) => void;
  /** "Add <branch level> here" on a group node: a new branch placed under it. */
  onAddBranch: (parentLocationId: string) => void;
}

/**
 * Organisation → Locations, the tree (docs/locations.md §1): groups, branches and places depth-first, each row with its
 * level, code, rolled-up employee and device counts and its actions. Searching keeps the matches and their ancestors;
 * "Show archived" loads the archived locations too. Actions follow the member's reach (useLocationAccess): the structure
 * (groups, branch placement) for members with every branch, the places of their branches for branch-scoped managers.
 */
export function LocationTreePanel({ tree, access, showArchived, onShowArchivedChange, onEditBranch, onAddBranch }: LocationTreePanelProps) {
  const { t } = useTranslation(LOCATIONS_NS);
  const { update } = useLocationMutations();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  /** null = the default (see AUTO_EXPAND_MAX) until the member opens or closes something. */
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  /** While searching every path to a match is open; these are the ones closed by hand (reset with the query). */
  const [closedInSearch, setClosedInSearch] = useState<ReadonlySet<string>>(() => new Set());
  const [dialog, setDialog] = useState<TreeDialog | null>(null);

  const parents = useMemo(() => new Set(tree.nodes.filter((n) => (tree.children.get(n.id)?.length ?? 0) > 0).map((n) => n.id)), [tree]);
  const defaultExpanded = useMemo<ReadonlySet<string>>(
    () => (tree.nodes.length <= AUTO_EXPAND_MAX ? parents : new Set((tree.children.get(null) ?? []).map((n) => n.id))),
    [tree, parents],
  );
  const search = useMemo(() => searchTree(tree, deferredQuery, (n) => [n.name, n.nameAr, n.code]), [tree, deferredQuery]);
  const open = expanded ?? defaultExpanded;
  const topLevels = useMemo(() => childLevelsFor(tree, null), [tree]);

  const visibleChildren = (id: string | null) => (tree.children.get(id) ?? []).filter((n) => !search || search.visible.has(n.id));
  const isOpen = (id: string) => (search ? !closedInSearch.has(id) : open.has(id));
  const toggle = (id: string) => {
    if (search) setClosedInSearch((s) => toggled(s, id));
    else setExpanded((s) => toggled(s ?? defaultExpanded, id));
  };
  const expandAll = () => { setExpanded(parents); setClosedInSearch(new Set()); };
  const collapseAll = () => { setExpanded(new Set()); if (search) setClosedInSearch(new Set(search.visible)); };

  const restore = (node: LocationDto) => update.mutate({ id: node.id, input: { status: 'active' } }, {
    onSuccess: () => toast.success(t('tree.restored', { name: tree.nameOf(node) })),
    onError: toastError,
  });

  const addAction = (node: LocationDto): RowAction | null => {
    const levels = childLevelsFor(tree, node);
    if (levels.length === 0) return null;
    const label = levels.length === 1 ? t('tree.actions.addLevel', { level: tree.levelName(levels[0]) }) : t('tree.actions.addChild');
    return { key: 'add', label, icon: <Plus />, onSelect: () => setDialog({ kind: 'form', state: { mode: 'add', parent: node } }) };
  };

  /** What the member may do with a node (the server re-checks every write). */
  const actionsFor = (node: LocationDto): RowAction[] => {
    const archived = node.status === 'archived';
    const out: RowAction[] = [];
    const push = (a: RowAction | null) => { if (a) out.push(a); };
    if (node.role === 'branch') {
      if (!archived && access.placesOf(node.branchId)) push(addAction(node));
      if (node.branchId && access.branchOf(node.branchId)) { const branchId = node.branchId; push({ key: 'edit-branch', label: t('tree.actions.editBranch'), icon: <Pencil />, onSelect: () => onEditBranch(branchId) }); }
      if (!archived && access.structure && tree.hasGroupLevels) push({ key: 'place', label: t('tree.actions.placeUnder'), icon: <FolderInput />, onSelect: () => setDialog({ kind: 'move', node }) });
      return out;
    }
    if (node.role === 'group' ? !access.structure : !access.placesOf(node.branchId)) return out;
    if (archived) {
      const parent = node.parentId ? tree.byId.get(node.parentId) : undefined;
      push({ key: 'restore', label: t('tree.actions.restore'), icon: <ArchiveRestore />, disabled: parent?.status === 'archived' || update.isPending, onSelect: () => restore(node) });
      return out;
    }
    push(addAction(node));
    if (node.role === 'group' && tree.branchLevel) push({ key: 'add-branch', label: t('tree.actions.addBranch', { level: tree.levelName(tree.branchLevel) }), icon: <Building2 />, onSelect: () => onAddBranch(node.id) });
    push({ key: 'edit', label: t('tree.actions.edit'), icon: <Pencil />, onSelect: () => setDialog({ kind: 'form', state: { mode: 'edit', node } }) });
    push({ key: 'move', label: t('tree.actions.move'), icon: <FolderInput />, onSelect: () => setDialog({ kind: 'move', node }) });
    push({ key: 'archive', label: t('tree.actions.archive'), icon: <Archive />, destructive: true, onSelect: () => setDialog({ kind: 'archive', node }) });
    return out;
  };

  const renderNode = (node: LocationDto, depth: number): ReactNode => {
    const kids = visibleChildren(node.id);
    const isExpanded = kids.length > 0 && isOpen(node.id);
    const name = tree.nameOf(node);
    const level = tree.levelsById.get(node.levelId);
    const listId = `loc-children-${node.id}`;
    const employees = t('tree.employees', { count: node.employeeCount });
    const devices = t('tree.devices', { count: node.deviceCount });
    return (
      <li key={node.id} data-testid={`loc-node-${node.id}`}>
        {/* toggle · icon · [name and code | level, status, counts — wrap under the name on a phone] · actions (never wrap) */}
        <div
          className={cn('flex items-start gap-2 rounded-md py-1.5 pe-1 ps-[calc(var(--depth)*0.75rem)] hover:bg-muted/50 sm:items-center sm:ps-[calc(var(--depth)*1.5rem)]', node.status === 'archived' && 'text-muted-foreground')}
          style={{ '--depth': depth } as CSSProperties}
        >
          {kids.length > 0 ? (
            <button
              type="button" onClick={() => toggle(node.id)} aria-expanded={isExpanded} aria-controls={isExpanded ? listId : undefined}
              aria-label={isExpanded ? t('tree.collapse', { name }) : t('tree.expand', { name })}
              className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground sm:mt-0"
            >
              {isExpanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />}
            </button>
          ) : <span className="size-6 shrink-0" aria-hidden />}
          <span className={cn('mt-1 flex size-7 shrink-0 items-center justify-center rounded-md sm:mt-0', node.role === 'branch' ? 'bg-accent text-brand-700' : 'bg-muted text-foreground')}>
            <LevelIcon icon={level?.icon} />
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 basis-40">
              <span className={cn('block truncate text-sm font-medium', search?.matches.has(node.id) && 'text-primary')}>{name}</span>
              {/* an LTR island inside a line that follows the page, so in Arabic the code still sits under the name */}
              <span className="block truncate font-mono text-xs text-muted-foreground"><span dir="ltr">{node.code}</span></span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{tree.levelName(level)}</Badge>
              {node.status !== 'active' ? <Badge variant={node.status === 'archived' ? 'neutral' : 'warning'} dot>{t(`tree.status.${node.status}`)}</Badge> : null}
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                <span role="img" aria-label={employees} title={employees} className="inline-flex items-center gap-1"><Users className="size-3.5" aria-hidden /><span className="tnum">{fmtNumber(node.employeeCount)}</span></span>
                <span role="img" aria-label={devices} title={devices} className="inline-flex items-center gap-1"><Fingerprint className="size-3.5" aria-hidden /><span className="tnum">{fmtNumber(node.deviceCount)}</span></span>
              </span>
            </span>
          </div>
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center sm:mt-0">
            <RowActions actions={actionsFor(node)} label={t('tree.actionsFor', { name })} />
          </span>
        </div>
        {isExpanded ? <ul id={listId}>{kids.map((k) => renderNode(k, depth + 1))}</ul> : null}
      </li>
    );
  };

  const roots = visibleChildren(null);
  const loading = tree.isLoading && tree.nodes.length === 0;
  let body: ReactNode;
  if (tree.error && tree.nodes.length === 0) body = <ErrorState error={tree.error} onRetry={tree.refetch} />;
  else if (loading) body = <div className="space-y-2" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" style={{ marginInlineStart: `${(i % 3) * 1.5}rem` }} />)}</div>;
  else if (tree.nodes.length === 0) body = <EmptyState icon={ListTree} title={t('tree.empty')} description={t('tree.emptyHint')} />;
  else if (search && roots.length === 0) body = <p className="py-8 text-center text-sm text-muted-foreground">{t('tree.noMatches', { query: deferredQuery.trim() })}</p>;
  else body = <ul aria-label={t('tree.label')} className={cn('space-y-0.5', tree.isFetching && 'opacity-80')}>{roots.map((n) => renderNode(n, 0))}</ul>;

  return (
    <Card>
      <div className="space-y-1 p-5 pb-3">
        <h2 className="text-base font-semibold leading-tight">{t('tree.title')}</h2>
        <p className="max-w-prose text-sm text-muted-foreground">{t('tree.description')}</p>
      </div>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="loc-search" type="search" value={query} onChange={(e) => { setQuery(e.target.value); setClosedInSearch(new Set()); }} placeholder={t('tree.searchPlaceholder')} aria-label={t('tree.search')} className="h-8 ps-8" />
          </div>
          <div className="flex items-center gap-2 px-1">
            <Switch id="loc-archived" checked={showArchived} onCheckedChange={onShowArchivedChange} />
            <Label htmlFor="loc-archived" className="font-normal">{t('tree.showArchived')}</Label>
          </div>
          <Button variant="ghost" size="sm" onClick={expandAll} disabled={parents.size === 0}><ChevronsUpDown />{t('tree.expandAll')}</Button>
          <Button variant="ghost" size="sm" onClick={collapseAll} disabled={parents.size === 0}><ChevronsDownUp />{t('tree.collapseAll')}</Button>
          {access.structure && topLevels.length > 0 ? (
            <Button size="sm" className="ms-auto" onClick={() => setDialog({ kind: 'form', state: { mode: 'add', parent: null } })}><Plus />{t('tree.addTop', { level: tree.levelName(topLevels[0]) })}</Button>
          ) : null}
        </div>
        <p className="sr-only" aria-live="polite">{search ? t('tree.matches', { count: search.matches.size }) : ''}</p>
        {body}
      </CardContent>
      {dialog?.kind === 'form' ? <LocationDialog key={dialog.state.mode === 'edit' ? dialog.state.node.id : `add-${dialog.state.parent?.id ?? 'top'}`} state={dialog.state} tree={tree} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'move' ? <MoveLocationDialog key={dialog.node.id} node={dialog.node} tree={tree} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'archive' ? <ArchiveLocationDialog key={dialog.node.id} node={dialog.node} tree={tree} onClose={() => setDialog(null)} /> : null}
    </Card>
  );
}
