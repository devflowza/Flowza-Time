import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { GripVertical, UserCheck, Workflow, X } from 'lucide-react';
import type { OrgChartNodeDto } from '@flowza/contracts';
import { Avatar, Badge, Button, Checkbox, ErrorState, Input, Skeleton } from '@/components/ui';
import { useDebounced } from '@/hooks/use-debounced';
import { cn } from '@/lib/utils';
import { levelNodes, useOrgChartLevel } from './api';
import { useLoadUntilFound, useOrgChart } from './context';
import { useDragSource, useDropTarget } from './dnd';
import { PersonMenu } from './person-menu';

interface UnassignedPanelProps {
  search: string;
  onSearchChange: (search: string) => void;
  onClose: () => void;
}

/**
 * The people who are not on the chart yet: no manager in the chart's set and nobody reporting to them. Searchable and
 * paginated; rows can be dragged onto a card (or onto another row: that person becomes their manager), or selected and
 * given a manager in one go, and every row has the person's ⋯ menu (Add direct reports… builds a first team).
 *
 * "No manager in the chart's set" is not "no manager": the set is narrowed by the branch / department filter and the
 * reader's branch scope, so somebody may report to a manager in another branch. Such a row says so, "Select all" leaves it
 * out, and the dialogs warn that assigning a manager replaces that reporting line.
 */
export function UnassignedPanel({ search, onSearchChange, onClose }: UnassignedPanelProps) {
  const { t } = useTranslation('employees');
  const ctx = useOrgChart();
  const debounced = useDebounced(search, 250);
  const q = useOrgChartLevel({ view: 'unassigned', search: debounced }, ctx.filters);
  const items = levelNodes(q.data);
  const total = q.data?.pages[0]?.meta.total ?? 0;
  // focusing somebody listed here (find, ?focus=): the panel searches their number, which may match more than one page —
  // load on until their row is there (only for that search: a search the reader types is theirs)
  const wanted = ctx.focus && ctx.focus.search !== undefined && ctx.focus.search === debounced ? ctx.focus.id : undefined;
  useLoadUntilFound(q, wanted);
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(() => new Map());
  // a selection only holds people still listed (an assignment moves them onto the chart)
  const listed = new Set(items.map((n) => n.id));
  const chosen = [...selected].filter(([id]) => listed.has(id));
  const notListed = !!wanted && !q.isPending && !q.isError && !q.hasNextPage && !q.isFetchingNextPage && !listed.has(wanted);
  // "Select all" takes the people with no manager at all; somebody whose manager is outside this view is ticked on purpose
  const free = items.filter((n) => n.managerEmployeeId === null);
  const mixed = free.length !== items.length;
  const allChosen = free.length > 0 && free.every((n) => selected.has(n.id));

  const toggle = (n: OrgChartNodeDto, on: boolean) => setSelected((prev) => {
    const next = new Map(prev);
    if (on) next.set(n.id, ctx.nameOf(n)); else next.delete(n.id);
    return next;
  });
  const toggleAll = (on: boolean) => setSelected(on ? new Map(free.map((n) => [n.id, ctx.nameOf(n)])) : new Map());
  const outside = new Set(items.filter((n) => n.managerEmployeeId !== null).map((n) => n.id));
  const assignSelected = () => ctx.edit({
    kind: 'assign', employeeIds: chosen.map(([id]) => id), subjectName: chosen.length === 1 ? chosen[0]?.[1] : undefined, line: 'primary',
    outsideManagerCount: chosen.filter(([id]) => outside.has(id)).length,
    onDone: () => setSelected(new Map()),
  });
  const selectAllLabel = mixed ? t('orgChart.unassigned.selectAllFree') : t('orgChart.unassigned.selectAll');

  return (
    <aside aria-labelledby="org-unassigned-title" className="flex max-h-[calc(100dvh-14rem)] min-h-80 flex-col rounded-xl border bg-card shadow-card">
      <div className="flex items-start justify-between gap-2 border-b p-4 pb-3">
        <div className="min-w-0">
          <h2 id="org-unassigned-title" className="flex items-center gap-2 text-sm font-semibold">{t('orgChart.unassigned.title')} <Badge variant="secondary" className="tnum">{total}</Badge></h2>
          <p className="mt-1 text-xs text-muted-foreground">{ctx.canEdit ? t('orgChart.unassigned.hintEdit') : t('orgChart.unassigned.hint')}</p>
        </div>
        <Button variant="ghost" size="icon" className="-me-2 -mt-1 size-8 shrink-0" onClick={onClose} aria-label={t('orgChart.unassigned.close')}><X /></Button>
      </div>
      <div className="space-y-2 border-b p-3">
        <Input type="search" value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder={t('orgChart.unassigned.searchPlaceholder')} aria-label={t('orgChart.unassigned.search')} className="h-8" maxLength={100} />
        {ctx.canEdit && free.length > 0 ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={allChosen ? true : chosen.length > 0 ? 'indeterminate' : false} onCheckedChange={(v) => toggleAll(v === true)} aria-label={selectAllLabel} />
            <span aria-hidden>{selectAllLabel}</span>
          </label>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {q.isPending ? (
          <div className="space-y-2 p-1" aria-busy>{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <p className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
            <UserCheck className="size-5" aria-hidden />
            {debounced.trim() ? t('orgChart.unassigned.noMatch', { search: debounced.trim() }) : t('orgChart.unassigned.empty')}
          </p>
        ) : (
          <ul className="space-y-1" aria-label={t('orgChart.unassigned.title')}>
            {items.map((n) => <UnassignedRow key={n.id} node={n} checked={selected.has(n.id)} onCheck={(on) => toggle(n, on)} />)}
          </ul>
        )}
        {notListed ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t('orgChart.unassigned.notListed')}</p> : null}
        {q.hasNextPage ? (
          <div className="flex justify-center p-2">
            <Button size="sm" variant="outline" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('orgChart.showMore', { count: total - items.length })}</Button>
          </div>
        ) : null}
      </div>
      {ctx.canEdit ? (
        <div className="border-t p-3">
          <Button className="w-full" size="sm" disabled={chosen.length === 0} onClick={assignSelected}><Workflow /> {t('orgChart.unassigned.assignSelected', { count: chosen.length })}</Button>
        </div>
      ) : null}
    </aside>
  );
}

function UnassignedRow({ node, checked, onCheck }: { node: OrgChartNodeDto; checked: boolean; onCheck: (on: boolean) => void }) {
  const { t } = useTranslation('employees');
  const ctx = useOrgChart();
  const name = ctx.nameOf(node);
  const rowRef = useRef<HTMLLIElement>(null);
  const focused = ctx.focus?.id === node.id;
  const nonce = focused ? ctx.focus?.nonce : undefined;
  const drag = useDragSource({ id: node.id, name, managerEmployeeId: node.managerEmployeeId });
  const drop = useDropTarget({ id: node.id, name });
  const outside = node.managerEmployeeId !== null;
  // once per focus request: a new search re-mounts the row, and must not scroll the panel back to it
  const { claimFocus } = ctx;
  useEffect(() => { if (nonce !== undefined && claimFocus(nonce)) rowRef.current?.scrollIntoView({ block: 'nearest' }); }, [nonce, claimFocus]);
  return (
    <li
      ref={rowRef}
      data-testid={`unassigned-row-${node.id}`}
      {...drag}
      {...drop.props}
      className={cn(
        'flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:bg-muted/60',
        ctx.canEdit && 'cursor-grab active:cursor-grabbing',
        (checked || focused) && 'border-ring/50 bg-accent/40',
        drop.state === 'valid' && 'border-ring bg-accent/60',
        drop.state === 'invalid' && 'border-destructive/50',
      )}
    >
      {ctx.canEdit ? <GripVertical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
      {ctx.canEdit ? <Checkbox checked={checked} onCheckedChange={(v) => onCheck(v === true)} aria-label={t('orgChart.unassigned.select', { name })} /> : null}
      <Avatar name={name} src={node.photoUrl} className="size-7" />
      <div className="min-w-0 flex-1">
        <Link to={`/employees/${node.id}`} draggable={false} className="block truncate text-sm font-medium hover:underline">{name}</Link>
        <p className="truncate text-xs text-muted-foreground"><span dir="ltr" className="font-mono">{node.employeeNumber}</span>{node.designationName ? ` · ${node.designationName}` : ''}{node.departmentName ? ` · ${node.departmentName}` : ''}</p>
        {outside ? <Badge variant="warning" className="mt-1 block w-fit max-w-full truncate font-normal">{t('orgChart.unassigned.outsideManager')}</Badge> : null}
      </div>
      {ctx.canEdit ? <PersonMenu node={node} name={name} /> : null}
    </li>
  );
}
