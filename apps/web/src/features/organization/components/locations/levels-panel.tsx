import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpToLine, ChevronRight, LayoutTemplate, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { LOCATION_LEVELS_MAX, type LocationLevelDto } from '@flowza/contracts';
import {
  Button, Card, CardContent, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  ErrorState, Skeleton, Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui';
import { useLocationLevelMutations } from '@/features/locations/api';
import { LevelIcon } from '@/features/locations/components/level-icon';
import { LOCATIONS_NS } from '@/features/locations/locale';
import { canAddLevel, levelDeleteBlock } from '@/features/locations/rules';
import type { LocationTree } from '@/features/locations/use-location-tree';
import { ApiError } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Callout } from './callout';
import { LevelDialog, type LevelDialogState } from './level-dialog';
import { TemplateDialog } from './template-dialog';
import type { LocationAccess } from './use-location-access';

/** The kebab of one level: rename, insert a level above / below it, delete it (refused with the reason when it cannot go). */
function LevelMenu({ level, tree, onEdit, onDelete }: { level: LocationLevelDto; tree: LocationTree; onEdit: (s: LevelDialogState) => void; onDelete: (l: LocationLevelDto) => void }) {
  const { t } = useTranslation(LOCATIONS_NS);
  const reasonId = useId();
  const name = tree.levelName(level);
  const block = levelDeleteBlock(level);
  const canAdd = canAddLevel(tree.levels);
  const reason = block === 'BRANCH_LEVEL' ? t('levels.branchLevelKept', { name }) : block === 'IN_USE' ? t('levels.inUse', { count: level.locationCount }) : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label={t('levels.actionsFor', { name })}><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => onEdit({ mode: 'rename', level })}><Pencil />{t('levels.rename')}</DropdownMenuItem>
        <DropdownMenuItem disabled={!canAdd} onSelect={() => onEdit({ mode: 'create', position: level.position })}><ArrowUpToLine />{t('levels.addAbove')}</DropdownMenuItem>
        <DropdownMenuItem disabled={!canAdd} onSelect={() => onEdit({ mode: 'create', position: level.position + 1 })}><ArrowDownToLine />{t('levels.addBelow')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        {reason ? (
          // not `disabled`: a disabled item takes no pointer or focus, and the tooltip saying why would never open
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuItem aria-disabled="true" aria-describedby={reasonId} className="opacity-50" onSelect={(e) => e.preventDefault()}>
                <Trash2 />{t('levels.delete')}
                {/* the description screen readers get without the tooltip (hidden text still describes when referenced) */}
                <span id={reasonId} hidden>{reason}</span>
              </DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-64">{reason}</TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenuItem destructive onSelect={() => onDelete(level)}><Trash2 />{t('levels.delete')}</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Deleting a level: the server shifts the levels below it up one place, and refuses (409) while a location uses it. */
function DeleteLevelDialog({ level, tree, onClose }: { level: LocationLevelDto; tree: LocationTree; onClose: () => void }) {
  const { t } = useTranslation(LOCATIONS_NS);
  const { remove } = useLocationLevelMutations();
  const [error, setError] = useState<string | null>(null);
  const name = tree.levelName(level);
  return (
    <ConfirmDialog
      open onOpenChange={(o) => { if (!o) onClose(); }} title={t('levels.deleteTitle', { name })} description={t('levels.deleteHint')} confirmLabel={t('levels.delete')} destructive loading={remove.isPending}
      onConfirm={() => { setError(null); remove.mutate(level.id, { onSuccess: () => { toast.success(t('levels.deleted')); onClose(); }, onError: (e) => setError(e instanceof ApiError ? e.message : t('levels.deleteFailed')) }); }}
    >
      {error ? <Callout tone="error">{error}</Callout> : null}
    </ConfirmDialog>
  );
}

/**
 * The levels as a chain, top first: icon, name in the UI language and how many locations use it. What the levels are for
 * — grouping, the operating unit, places in a branch — is said once above the first level of each kind (and in every card
 * for screen readers), which keeps the cards narrow enough for a five-level chain to fit on one line.
 */
function LevelChain({ tree, access, onEdit, onDelete }: { tree: LocationTree; access: LocationAccess; onEdit: (s: LevelDialogState) => void; onDelete: (l: LocationLevelDto) => void }) {
  const { t } = useTranslation(LOCATIONS_NS);
  return (
    <ol aria-label={t('levels.chainLabel')} className="flex flex-wrap items-start gap-x-1.5 gap-y-2">
      {tree.levels.map((l, i) => {
        const startsKind = i === 0 || tree.levels[i - 1]?.role !== l.role;
        return (
          <li key={l.id} className="flex min-w-0 max-w-full flex-col gap-1" data-testid={`level-${l.id}`}>
            {/* an empty caption keeps the cards of one line aligned; stacked on a phone it would only add a gap */}
            <span aria-hidden className={cn('h-4 truncate text-xs font-medium leading-4 text-muted-foreground', startsKind ? 'block' : 'hidden sm:block', i > 0 && 'ps-[1.375rem]')}>{startsKind ? t(`roles.${l.role}`) : ''}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              {i > 0 ? <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden /> : null}
              <span className={cn('flex min-w-0 items-center gap-2 rounded-lg border py-1.5 ps-2 pe-1', l.role === 'branch' ? 'border-primary/40 bg-accent' : 'bg-card')}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground"><LevelIcon icon={l.icon} /></span>
                <span className="min-w-0 pe-1">
                  <span className="block truncate text-sm font-medium">{tree.levelName(l)}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <span className="sr-only">{t(`roles.${l.role}`)} · </span>
                    <span className="tnum">{l.role === 'branch' ? t('levels.branchCount', { count: l.locationCount }) : t('levels.count', { count: l.locationCount })}</span>
                  </span>
                </span>
                {access.structure ? <LevelMenu level={l} tree={tree} onEdit={onEdit} onDelete={onDelete} /> : null}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Organisation → Locations, the levels (docs/locations.md §1): the organisation's own names for its levels, top first, and
 * — for members with branch.manage and every branch — renaming, inserting above / below, deleting and templates. An
 * organisation with only the branch level is told what a hierarchy is for, with the two ways to start one.
 */
export function LevelsPanel({ tree, access }: { tree: LocationTree; access: LocationAccess }) {
  const { t } = useTranslation(LOCATIONS_NS);
  const [editing, setEditing] = useState<LevelDialogState | null>(null);
  const [deleting, setDeleting] = useState<LocationLevelDto | null>(null);
  const [templates, setTemplates] = useState(false);
  const branchName = tree.levelName(tree.branchLevel);
  const loaded = tree.levels.length > 0;
  const simple = loaded && tree.levels.every((l) => l.role === 'branch');
  const canAdd = canAddLevel(tree.levels);
  const addLevel = () => setEditing({ mode: 'create', position: tree.branchLevel ? tree.branchLevel.position : 1 });

  const actions = access.structure && loaded ? (
    <>
      <Button variant="outline" size="sm" onClick={() => setTemplates(true)}><LayoutTemplate />{t('levels.useTemplate')}</Button>
      <Button size="sm" variant={simple ? 'default' : 'outline'} disabled={!canAdd} onClick={addLevel}><Plus />{t('levels.add')}</Button>
    </>
  ) : null;

  return (
    <Card>
      <div className="flex flex-col gap-3 p-5 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold leading-tight">{t('levels.title')}</h2>
          <p className="max-w-prose text-sm text-muted-foreground">{t('levels.description', { branch: branchName || t('icons.branch') })}</p>
        </div>
        {actions && !simple ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
      <CardContent className="space-y-4">
        {tree.error && !loaded ? <ErrorState error={tree.error} onRetry={tree.refetch} />
          : !loaded ? (
            <div className="flex flex-wrap gap-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-44" />)}</div>
          ) : <LevelChain tree={tree} access={access} onEdit={setEditing} onDelete={setDeleting} />}
        {loaded && !canAdd && access.structure ? <p className="text-xs text-muted-foreground">{t('levels.maxReached', { max: LOCATION_LEVELS_MAX })}</p> : null}
        {simple ? (
          <div className="space-y-3 rounded-lg border border-dashed bg-muted/40 p-4" data-testid="locations-simple">
            <h3 className="text-sm font-semibold">{t('simple.title', { branch: branchName })}</h3>
            <p className="max-w-prose text-sm text-muted-foreground">{t('simple.body')}</p>
            <p className="text-sm font-medium" dir="auto">{t('simple.example')}</p>
            <p className="max-w-prose text-sm text-muted-foreground">{access.structure ? t('simple.next', { branch: branchName }) : t('simple.askAdmin')}</p>
            {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
          </div>
        ) : null}
        {loaded && !access.structure && access.manage ? <p className="text-xs text-muted-foreground">{t('levels.scopedHint')}</p> : null}
      </CardContent>
      {editing ? <LevelDialog key={editing.mode === 'rename' ? editing.level.id : `new-${editing.position}`} state={editing} tree={tree} onClose={() => setEditing(null)} /> : null}
      {deleting ? <DeleteLevelDialog level={deleting} tree={tree} onClose={() => setDeleting(null)} /> : null}
      {templates ? <TemplateDialog tree={tree} onClose={() => setTemplates(false)} /> : null}
    </Card>
  );
}
