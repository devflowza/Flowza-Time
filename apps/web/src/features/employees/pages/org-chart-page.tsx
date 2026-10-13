import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronsDownUp, UserRoundX, Users, Workflow, X, ZoomIn, ZoomOut } from 'lucide-react';
import { uuidSchema, type OrgChartFilter, type OrgChartPathDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { ApiError } from '@/lib/api-client';
import { useUiDirection } from '@/lib/direction';
import { useLocalName } from '@/lib/local-name';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgId } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { employeeDetailQuery, useEmployeeOptions } from '../api';
import { isInTeamOf, levelNodes, loadedOrgChartNodes, orgChartPathQuery, useOrgChartLevel } from '../org-chart/api';
import { OrgChartContext, useLoadUntilFound, wantedOnLevel, type OrgChartContextValue, type OrgChartDragItem, type OrgChartEdit, type OrgChartFocus, type PersonRef } from '../org-chart/context';
import { OrgChartHeads } from '../org-chart/org-chart-tree';
import { UnassignedPanel } from '../org-chart/unassigned-panel';
import { OrgChartEditDialog } from '../org-chart/edit-dialogs';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;

/**
 * The organisation's reporting lines as a top-down chart (primary manager; the dotted line is shown on the card), one level
 * at a time. HR can find a person, filter by branch / department, zoom, and — with employee.update — change who reports to
 * whom from a card's menu, by dragging a card onto its new manager, or from the people who are not on the chart yet.
 */
export default function OrgChartPage() {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canEdit = can('employee.update');
  const orgId = useOrgId();
  const qc = useQueryClient();
  const localName = useLocalName();
  const [params, setParams] = useSearchParams();
  // ?focus=<employeeId> (the profile's "View in org chart"). Only an employee id is taken: the value goes into API paths, and a
  // crafted link (`?focus=..%2F..%2F<route>`) must never make the reader's browser call another endpoint with their token.
  const focusParam = params.get('focus');
  const focusId = focusParam && uuidSchema.safeParse(focusParam).success ? focusParam : null;

  const [branchId, setBranchId] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const filters = useMemo<OrgChartFilter>(() => ({ ...(branchId ? { branchId } : {}), ...(departmentId ? { departmentId } : {}) }), [branchId, departmentId]);
  const hasFilters = !!branchId || !!departmentId;
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(branchId);
  const people = useEmployeeOptions();

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<OrgChartFocus | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panel, setPanel] = useState<{ open: boolean; search: string }>({ open: false, search: '' });
  const [edit, setEdit] = useState<OrgChartEdit | null>(null);
  const [dragging, setDragging] = useState<OrgChartDragItem | null>(null);

  const headsQ = useOrgChartLevel({ view: 'top' }, filters);
  useLoadUntilFound(headsQ, wantedOnLevel(focus, null));
  // the count on the Unassigned button; the panel's first page with an empty search is this very query
  const unassignedQ = useOrgChartLevel({ view: 'unassigned' }, filters);
  const heads = levelNodes(headsQ.data);
  const headsTotal = headsQ.data?.pages[0]?.meta.total ?? 0;
  const unassignedTotal = unassignedQ.data?.pages[0]?.meta.total;
  // "unassigned" means no manager inside this view: with a filter, or for a reader scoped to some branches, people may well
  // report to somebody in another branch or department — the empty state must not tell HR they have no manager at all
  const outsideView = hasFilters || levelNodes(unassignedQ.data).some((n) => n.managerEmployeeId !== null);

  // every focus request gets the next number; the card or row showing the person lands on it once (claimFocus)
  const focusSeq = useRef(0);
  const landedFocus = useRef(0);
  const [glow, setGlow] = useState<number | null>(null);

  /** Opens the chart down to a person (or the Unassigned panel on them), scrolls their card into view and highlights it. */
  const focusPerson = async (id: string, employeeNumber?: string) => {
    let path: OrgChartPathDto;
    try {
      path = await qc.fetchQuery(orgChartPathQuery(orgId, id, filters));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) toast.info(t('orgChart.focus.notOnChart'));
      else toastError(err);
      return;
    }
    if (path.placement === 'unassigned') {
      let number = employeeNumber;
      if (!number) number = await qc.fetchQuery(employeeDetailQuery(orgId, id)).then((e) => e.employeeNumber, () => undefined);
      const search = number ?? '';
      setPanel({ open: true, search });
      setFocus({ id, path: [], nonce: ++focusSeq.current, search });
      return;
    }
    setExpanded((prev) => new Set([...prev, ...path.ancestorIds]));
    setFocus({ id, path: [...path.ancestorIds, id], nonce: ++focusSeq.current });
  };

  // ?focus= lands on the person once; a person picked here writes it too, without focusing twice
  const handledFocus = useRef<string | null>(null);
  const onFocusParam = useEffectEvent((id: string) => { void focusPerson(id); });
  useEffect(() => {
    if (!focusId || focusId === handledFocus.current) return;
    handledFocus.current = focusId;
    onFocusParam(focusId);
  }, [focusId]);
  const pickPerson = (id: string | null) => {
    if (!id) {
      setFocus(null);
      handledFocus.current = null;
      setParams((prev) => { const next = new URLSearchParams(prev); next.delete('focus'); return next; }, { replace: true });
      return;
    }
    handledFocus.current = id;
    setParams((prev) => { const next = new URLSearchParams(prev); next.set('focus', id); return next; }, { replace: true });
    void focusPerson(id, people.options.find((o) => o.value === id)?.description);
  };

  const nameOf: OrgChartContextValue['nameOf'] = (n) => localName(n.displayName, n.displayNameAr);
  const ctx: OrgChartContextValue = {
    filters,
    canEdit,
    expanded,
    toggle: (id) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }),
    focus,
    claimFocus: (nonce) => {
      if (nonce <= landedFocus.current) return false;
      landedFocus.current = nonce;
      setGlow(nonce);
      return true;
    },
    glow,
    endGlow: (nonce) => setGlow((g) => (g === nonce ? null : g)),
    dragging,
    startDrag: setDragging,
    endDrag: () => setDragging(null),
    canDropOn: (targetId) => !!dragging && dragging.id !== targetId && !isInTeamOf(loadedOrgChartNodes(qc, orgId), targetId, dragging.id),
    dropOn: (target: PersonRef) => {
      const item = dragging;
      setDragging(null);
      if (!item) return;
      if (item.id === target.id) { toast.error(t('orgChart.dnd.self')); return; }
      if (item.managerEmployeeId === target.id) { toast.info(t('orgChart.dnd.already', { employee: item.name, manager: target.name })); return; }
      const nodes = loadedOrgChartNodes(qc, orgId);
      if (isInTeamOf(nodes, target.id, item.id)) { toast.error(t('orgChart.dnd.cycle', { employee: item.name, manager: target.name })); return; }
      const current = item.managerEmployeeId ? nodes.get(item.managerEmployeeId) : undefined;
      setEdit({ kind: 'move', employee: item, manager: target, currentManagerName: current ? nameOf(current) : null });
    },
    edit: setEdit,
    nameOf,
    managerNameOf: (n) => {
      const manager = n.managerEmployeeId ? loadedOrgChartNodes(qc, orgId).get(n.managerEmployeeId) : undefined;
      return manager ? nameOf(manager) : null;
    },
  };

  const zoomBy = (delta: number) => setZoom((z) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta)) * 10) / 10);
  const openUnassigned = () => setPanel((p) => ({ ...p, open: true }));

  let body: ReactNode;
  if (headsQ.isPending) body = <ChartSkeleton />;
  else if (headsQ.isError) body = <ErrorState error={headsQ.error} onRetry={() => void headsQ.refetch()} />;
  else if (heads.length === 0) {
    if (unassignedQ.isPending) body = <ChartSkeleton />;
    else if ((unassignedTotal ?? 0) > 0) {
      const count = unassignedTotal ?? 0;
      body = (
        <EmptyState icon={Workflow} title={outsideView ? t('orgChart.empty.noLinesInView') : t('orgChart.empty.noLines')}
          description={outsideView ? t('orgChart.empty.noLinesInViewHint', { count }) : t('orgChart.empty.noLinesHint', { count })} action={
          <div className="space-y-5">
            {canEdit ? (
              <ol className="mx-auto max-w-lg list-decimal space-y-1.5 ps-5 text-start text-sm text-muted-foreground">
                <li>{t('orgChart.empty.wayDrag')}</li>
                <li>{t('orgChart.empty.wayAddReports')}</li>
                <li>{t('orgChart.empty.wayBulk')}</li>
                <li>{t('orgChart.empty.wayImport')}</li>
              </ol>
            ) : <p className="text-sm text-muted-foreground">{t('orgChart.empty.askAdmin')}</p>}
            <div className="flex flex-wrap justify-center gap-2">
              {!panel.open ? <Button onClick={openUnassigned}><UserRoundX /> {t('orgChart.empty.openUnassigned')}</Button> : null}
              {hasFilters ? <Button variant="outline" onClick={() => { setBranchId(null); setDepartmentId(null); }}><X /> {tc('common.clearFilters')}</Button> : null}
              <Button asChild variant="outline"><Link to="/employees">{t('orgChart.backToList')}</Link></Button>
            </div>
          </div>
        } />
      );
    } else if (hasFilters) {
      body = <EmptyState icon={Users} title={t('orgChart.empty.noMatches')} description={t('orgChart.empty.noMatchesHint')} action={<Button variant="outline" onClick={() => { setBranchId(null); setDepartmentId(null); }}><X /> {tc('common.clearFilters')}</Button>} />;
    } else {
      body = <EmptyState icon={Users} title={t('orgChart.empty.noEmployees')} description={t('orgChart.empty.noEmployeesHint')} action={<Button asChild variant="outline"><Link to="/employees">{t('orgChart.backToList')}</Link></Button>} />;
    }
  } else {
    body = (
      <div role="region" aria-label={t('orgChart.canvasLabel')} tabIndex={0} data-testid="org-chart-canvas"
        className="h-[calc(100dvh-15rem)] min-h-[26rem] overflow-auto overscroll-contain rounded-xl border bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ZoomSurface zoom={zoom}>
          <div className="p-8">
            <OrgChartHeads heads={heads} />
            {headsQ.hasNextPage ? (
              <div className="mt-8 flex justify-center">
                <Button size="sm" variant="outline" loading={headsQ.isFetchingNextPage} onClick={() => void headsQ.fetchNextPage()}>{t('orgChart.showMore', { count: headsTotal - heads.length })}</Button>
              </div>
            ) : null}
          </div>
        </ZoomSurface>
      </div>
    );
  }

  return (
    <OrgChartContext.Provider value={ctx}>
      <div className="page-container">
        <PageHeader title={t('orgChart.title')} description={t('orgChart.subtitle')} actions={
          <Button asChild variant="outline" size="sm"><Link to="/employees"><Users /> {t('orgChart.backToList')}</Link></Button>
        } />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Combobox value={focus?.id ?? null} onChange={pickPerson} options={people.options} onSearch={people.setSearch} loading={people.isLoading} clearable placeholder={t('orgChart.find')} aria-label={t('orgChart.find')} className="h-8 w-60" />
          <Combobox value={branchId} onChange={(v) => { setBranchId(v); setDepartmentId(null); }} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} aria-label={tc('common.branch')} className="h-8 w-44" />
          <Combobox value={departmentId} onChange={setDepartmentId} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.department')} aria-label={tc('common.department')} className="h-8 w-44" />
          {hasFilters ? <Button variant="ghost" size="sm" onClick={() => { setBranchId(null); setDepartmentId(null); }}><X /> {tc('common.clearFilters')}</Button> : null}
          <div className="ms-auto flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t('orgChart.zoom.label')} className="flex items-center rounded-md border bg-card shadow-xs">
              <Button variant="ghost" size="icon" className="size-8" onClick={() => zoomBy(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} aria-label={t('orgChart.zoom.out')}><ZoomOut /></Button>
              <Button variant="ghost" size="sm" className="h-8 min-w-14 px-2 tnum" onClick={() => setZoom(1)}><span className="sr-only">{t('orgChart.zoom.reset')}: </span>{Math.round(zoom * 100)}%</Button>
              <Button variant="ghost" size="icon" className="size-8" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} aria-label={t('orgChart.zoom.in')}><ZoomIn /></Button>
            </div>
            <Button variant="outline" size="sm" onClick={() => setExpanded(new Set())} disabled={expanded.size === 0}><ChevronsDownUp /> {t('orgChart.collapseAll')}</Button>
            <Button variant={panel.open ? 'secondary' : 'outline'} size="sm" aria-pressed={panel.open} onClick={() => setPanel((p) => ({ ...p, open: !p.open }))}>
              <UserRoundX /> {t('orgChart.unassigned.button')}
              {unassignedTotal !== undefined ? <span className="rounded-full bg-muted-strong px-1.5 text-[11px] font-semibold leading-5 tnum">{unassignedTotal}</span> : null}
            </Button>
          </div>
        </div>
        {canEdit && heads.length > 0 ? <p className="mb-3 text-xs text-muted-foreground">{t('orgChart.dragHint')}</p> : null}
        <div className={cn('grid gap-4', panel.open && 'lg:grid-cols-[minmax(0,1fr)_20rem]')}>
          <div className="min-w-0">{body}</div>
          {panel.open ? (
            <div className="order-first lg:order-none">
              <UnassignedPanel search={panel.search} onSearchChange={(search) => setPanel((p) => ({ ...p, search }))} onClose={() => setPanel((p) => ({ ...p, open: false }))} />
            </div>
          ) : null}
        </div>
      </div>
      {edit ? <OrgChartEditDialog edit={edit} onClose={() => setEdit(null)} /> : null}
    </OrgChartContext.Provider>
  );
}

/**
 * Zoom is a transform (compositor only); the outer box takes the scaled size so the chart's viewport scrolls exactly as far
 * as the zoomed chart reaches. The scale grows from the start corner, mirrored in Arabic.
 */
function ZoomSurface({ zoom, children }: { zoom: number; children: ReactNode }) {
  const dir = useUiDirection();
  const innerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="mx-auto" style={size && size.w > 0 ? { width: size.w * zoom, height: size.h * zoom } : undefined}>
      <div ref={innerRef} data-zoom={zoom} className="w-max transition-transform duration-200 ease-out" style={{ transform: `scale(${zoom})`, transformOrigin: dir === 'rtl' ? 'top right' : 'top left' }}>
        {children}
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="flex flex-col items-center gap-10 rounded-xl border bg-muted/30 p-10" aria-busy>
      <Skeleton className="h-24 w-56 rounded-xl" />
      <div className="flex flex-wrap justify-center gap-6">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-56 rounded-xl" />)}</div>
    </div>
  );
}
