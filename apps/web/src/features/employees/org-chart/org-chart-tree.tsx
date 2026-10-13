import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { OrgChartNodeDto } from '@flowza/contracts';
import { Avatar, Button, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { levelNodes, useOrgChartLevel } from './api';
import { useLoadUntilFound, useOrgChart, wantedOnLevel } from './context';
import { useDragSource, useDropTarget } from './dnd';
import { PersonMenu } from './person-menu';

/*
 * Connector lines are borders on pseudo-elements, written with logical properties (start/end, border-s/-e, rounded-ss/-se)
 * so the whole chart mirrors in Arabic.
 *
 * Row (a team laid out side by side): the trunk drops from the manager's card, every report draws its half of the bar
 * (::before towards the start, ::after towards the end plus the drop to its card); the first and last reports leave
 * the outer halves out, an only child just continues the trunk.
 *
 * Stack (a team of two or more where nobody has reports of their own): a compact column under the manager — an elbow from the manager's
 * card to a rail on the start side, with a tick to every card — so a team of forty stays readable instead of 9000px wide.
 */
const ROW_TRUNK = 'relative flex flex-col items-center self-stretch pt-5 before:absolute before:top-0 before:start-1/2 before:h-5 before:border-s before:border-muted-foreground/40';
const ROW_ITEM = cn(
  'relative flex flex-col items-center px-3 pt-5',
  'before:absolute before:top-0 before:end-1/2 before:h-5 before:w-1/2 before:border-t before:border-muted-foreground/40',
  'after:absolute after:top-0 after:start-1/2 after:h-5 after:w-1/2 after:border-s after:border-t after:border-muted-foreground/40',
  'first:before:hidden first:after:rounded-ss-lg last:after:hidden last:before:rounded-se-lg last:before:border-e',
  'only:pt-0 only:before:hidden only:after:hidden',
);
const STACK_TRUNK = 'relative flex flex-col items-start self-stretch pt-4 ps-6 before:absolute before:top-0 before:start-3 before:end-1/2 before:h-2 before:rounded-ee-lg before:border-e before:border-b before:border-muted-foreground/40';
const STACK_ITEM = cn(
  'relative',
  'before:absolute before:-start-3 before:-top-2 before:h-[calc(100%+0.5rem)] before:border-s before:border-muted-foreground/40 last:before:h-[calc(50%+0.5rem)]',
  'after:absolute after:-start-3 after:top-1/2 after:w-3 after:border-t after:border-muted-foreground/40',
);
const ROOT_ITEM = 'flex flex-col items-center';

type Variant = 'root' | 'row' | 'stack';
const ITEM: Record<Variant, string> = { root: ROOT_ITEM, row: ROW_ITEM, stack: STACK_ITEM };

/** The heads of the chart, side by side (separate trees: no connector between them). */
export function OrgChartHeads({ heads }: { heads: OrgChartNodeDto[] }) {
  const { t } = useTranslation('employees');
  return (
    <ul className="flex items-start justify-center gap-12" aria-label={t('orgChart.chartLabel')}>
      {heads.map((n) => <OrgNode key={n.id} node={n} variant="root" />)}
    </ul>
  );
}

function OrgNode({ node, variant }: { node: OrgChartNodeDto; variant: Variant }) {
  const ctx = useOrgChart();
  const open = node.directReportCount > 0 && ctx.expanded.has(node.id);
  const childrenId = `org-children-${node.id}`;
  return (
    <li className={ITEM[variant]}>
      <OrgCard node={node} open={open} childrenId={childrenId} />
      <div id={childrenId} className="flex flex-col self-stretch">{open ? <OrgChildren manager={node} /> : null}</div>
    </li>
  );
}

/** The direct reports of an expanded card, loaded lazily one page (ORG_CHART_PAGE_SIZE) at a time. */
function OrgChildren({ manager }: { manager: OrgChartNodeDto }) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const ctx = useOrgChart();
  const q = useOrgChartLevel({ managerId: manager.id }, ctx.filters);
  useLoadUntilFound(q, wantedOnLevel(ctx.focus, manager.id));
  const items = levelNodes(q.data);
  const total = q.data?.pages[0]?.meta.total ?? 0;

  if (q.isPending) return <div className={ROW_TRUNK} aria-busy><Skeleton className="h-[5.75rem] w-56 rounded-xl" /></div>;
  if (q.isError) {
    return (
      <div className={ROW_TRUNK}>
        <div role="alert" className="flex w-56 flex-col items-center gap-2 rounded-xl border border-destructive/30 bg-card p-3 text-center text-xs">
          <span>{t('orgChart.levelError')}</span>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>{tc('common.retry')}</Button>
        </div>
      </div>
    );
  }
  if (items.length === 0) return null;
  // a lone report continues the trunk in a straight line; two or more without reports of their own stack up
  const compact = items.length > 1 && items.every((n) => n.directReportCount === 0);
  const more = q.hasNextPage ? (
    <Button size="sm" variant="outline" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
      {t('orgChart.showMore', { count: total - items.length })}
    </Button>
  ) : null;
  return compact ? (
    <div className={STACK_TRUNK}>
      <ul className="flex flex-col items-start gap-2" aria-label={t('orgChart.teamOf', { name: ctx.nameOf(manager) })}>
        {items.map((n) => <OrgNode key={n.id} node={n} variant="stack" />)}
      </ul>
      {more ? <div className="mt-2">{more}</div> : null}
    </div>
  ) : (
    <div className={ROW_TRUNK}>
      <ul className="flex items-start justify-center" aria-label={t('orgChart.teamOf', { name: ctx.nameOf(manager) })}>
        {items.map((n) => <OrgNode key={n.id} node={n} variant="row" />)}
      </ul>
      {more ? <div className="mt-3 flex justify-center">{more}</div> : null}
    </div>
  );
}

/** One person on the chart: who they are, their dotted line, how many report to them; a drag source and a drop target. */
function OrgCard({ node, open, childrenId }: { node: OrgChartNodeDto; open: boolean; childrenId: string }) {
  const { t } = useTranslation('employees');
  const ctx = useOrgChart();
  const name = ctx.nameOf(node);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const focused = ctx.focus?.id === node.id;
  const nonce = focused ? ctx.focus?.nonce : undefined;
  const drag = useDragSource({ id: node.id, name, managerEmployeeId: node.managerEmployeeId });
  const drop = useDropTarget({ id: node.id, name });

  // focusing this person (find, ?focus=): bring the card into the chart's viewport and move keyboard focus to their name —
  // once per request. The card mounts again when their manager's team is collapsed and reopened, or after a filter change;
  // that must not pull the viewport or the keyboard away from the toggle or the filter the reader just used.
  const { claimFocus } = ctx;
  useEffect(() => {
    if (nonce === undefined || !claimFocus(nonce)) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    cardRef.current?.scrollIntoView({ block: 'center', inline: 'center', behavior: reduce ? 'auto' : 'smooth' });
    linkRef.current?.focus({ preventScroll: true });
  }, [nonce, claimFocus]);

  const where = [node.departmentName, node.branchName].filter(Boolean).join(' · ');
  return (
    <div
      ref={cardRef}
      data-testid={`org-card-${node.id}`}
      data-focused={focused || undefined}
      {...drag}
      {...drop.props}
      className={cn(
        'relative w-56 rounded-xl border bg-card p-3 text-start shadow-card transition-[border-color,box-shadow] duration-150',
        ctx.canEdit && 'cursor-grab active:cursor-grabbing',
        focused && 'border-ring ring-2 ring-ring/40',
        ctx.dragging?.id === node.id && 'opacity-60',
        drop.state === 'valid' && 'border-ring ring-2 ring-ring',
        drop.state === 'invalid' && 'border-destructive ring-2 ring-destructive/30',
      )}
    >
      {/* a brief glow when the chart lands on this person; it fades (opacity only), plays once per new focus, not on a remount */}
      {nonce !== undefined && ctx.glow === nonce ? (
        <span key={nonce} aria-hidden onAnimationEnd={() => ctx.endGlow(nonce)} className="pointer-events-none absolute -inset-1.5 animate-[fade-out_2.4s_var(--ease-in)_0.6s_forwards] rounded-2xl ring-4 ring-ring/35" />
      ) : null}
      <div className="flex items-start gap-2.5">
        <Avatar name={name} src={node.photoUrl} className="size-9" />
        <div className="min-w-0 flex-1">
          <Link ref={linkRef} to={`/employees/${node.id}`} draggable={false} className="block truncate text-sm font-semibold leading-snug hover:underline" title={name}>{name}</Link>
          <p className="truncate text-xs text-muted-foreground">{node.designationName ?? '—'}</p>
        </div>
        {ctx.canEdit ? <PersonMenu node={node} name={name} className="-me-1.5 -mt-1" /> : null}
      </div>
      <p className="mt-1.5 truncate text-xs text-muted-foreground" title={where || undefined}>{where || '—'}</p>
      {node.secondaryManagerName ? (
        <p className="mt-1.5 truncate rounded-md border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground" title={t('orgChart.card.alsoReportsTo', { name: node.secondaryManagerName })}>
          {t('orgChart.card.alsoReportsTo', { name: node.secondaryManagerName })}
        </p>
      ) : null}
      {node.directReportCount > 0 ? (
        <button type="button" aria-expanded={open} aria-controls={childrenId} onClick={() => ctx.toggle(node.id)}
          className="mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border bg-muted/50 px-2 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="sr-only">{name}: </span>
          <span className="tnum">{t('orgChart.card.reports', { count: node.directReportCount })}</span>
          <ChevronDown className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
