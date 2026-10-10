import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Cpu, MapPinned, Printer, RefreshCw, Search, X } from 'lucide-react';
import { MUSTER_STATES, type LocationMusterDto, type LocationMusterEntryDto, type MusterState } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorState, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtNumber, fmtTime, todayIso } from '@/lib/format';
import { useLocalName } from '@/lib/local-name';
import { useActiveMembership, useCan, useMe, useModulesEnabled, useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { LocationPicker } from '@/features/locations/components/location-picker';
import { useLocationTree, type LocationTree } from '@/features/locations/use-location-tree';
import { ancestorsOf } from '@/features/locations/tree';
import { useLocationMuster } from '../api';
import { SCHED_NS } from '../i18n';
import { filterMusterEntries, musterLocation, readRememberedLocation, rememberLocation, sortMusterEntries, type MusterSort } from '../muster';
import { MusterRollCall, MusterStatTile, MusterStateBadge } from '../components/muster-parts';

const ALL = '__all__';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SORTABLE: readonly string[] = ['employee', 'state', 'time', 'terminal', 'place'] satisfies readonly MusterSort[];
/** While the roll call prints, the app chrome and the screen view drop out so the sheet prints alone. */
const PRINT_CSS = '@media print { aside, header, [data-sonner-toaster], [data-print-hide] { display: none !important; } main { padding: 0 !important; } body { background: #fff !important; } }';

/**
 * /attendance/muster — "On site now" (Enterprise, advanced_scheduling; attendance.view): for a location of the tree and a day,
 * everyone whose latest punch was on a terminal placed in it or below (docs/locations.md §4) — the totals per state, the same
 * per child location (a row drills down), and the people with their last punch in the branch's timezone. The location comes
 * from the address (`?location=`, so the back button climbs up again), else the one this viewer looked at last, else the
 * first branch; `?date=` picks another day (default: the location's today). Refreshes every minute while visible and on focus.
 * The roll call prints for report.export holders, like every printed statement.
 */
export default function MusterPage() {
  const { t } = useTranslation(SCHED_NS);
  const { t: tc } = useTranslation();
  const orgId = useOrgId();
  const orgTz = useOrgTimezone();
  const userId = useMe().data?.user.id ?? '';
  const org = useActiveMembership()?.organization;
  const can = useCan();
  const modulesOn = useModulesEnabled();
  const tree = useLocationTree();
  const branches = useBranchOptions(true);
  const [params, setParams] = useSearchParams();
  const remembered = useMemo(() => readRememberedLocation(orgId, userId), [orgId, userId]);
  const fromUrl = params.get('location');
  const { byId, children, nodes } = tree;
  const locationId = useMemo(() => musterLocation({ byId, children, nodes }, fromUrl, remembered), [byId, children, nodes, fromUrl, remembered]);
  const dateParam = params.get('date');
  const date = dateParam && ISO_DATE.test(dateParam) ? dateParam : null;
  const q = useLocationMuster(locationId, date);
  const data = q.data;
  const node = locationId ? tree.byId.get(locationId) : undefined;
  const nodeName = node ? tree.nameOf(node) : '';

  const branchById = branches.byId;
  const tzOfBranch = useCallback((branchId: string | null | undefined) => (branchId ? branchById.get(branchId)?.timezone : undefined) ?? orgTz, [branchById, orgTz]);
  // a punch shows in its terminal's branch's time (the place's branch), else the employee's branch
  const entryTimezone = useCallback((e: LocationMusterEntryDto) => tzOfBranch(byId.get(e.locationId)?.branchId ?? e.branchId), [tzOfBranch, byId]);
  const locationTz = tzOfBranch(node?.branchId);

  const go = (id: string | null) => {
    if (!id || id === locationId) return;
    rememberLocation(orgId, userId, id);
    setParams((prev) => { const n = new URLSearchParams(prev); n.set('location', id); return n; });
  };
  const setDate = (d: string | null) => setParams((prev) => { const n = new URLSearchParams(prev); if (d) n.set('date', d); else n.delete('date'); return n; }, { replace: true });

  // ---- printing the roll call --------------------------------------------------------------------------------------------
  const canPrint = can('report.export');
  const [printing, setPrinting] = useState(false);
  const [printedAt, setPrintedAt] = useState(() => new Date().toISOString());
  const startPrint = useCallback(() => flushSync(() => { setPrintedAt(new Date().toISOString()); setPrinting(true); }), []);
  useEffect(() => {
    if (!canPrint) return;
    // the browser's own print command mounts the sheet too
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', startPrint);
    window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', startPrint); window.removeEventListener('afterprint', after); };
  }, [canPrint, startPrint]);
  const rollCall = useMemo(() => sortMusterEntries(data?.entries ?? [], 'state', 'asc'), [data]);

  const crumbs = locationId ? ancestorsOf(tree, locationId) : [];
  const showDevicesLink = can('device.view') && modulesOn('devices');

  return (
    <div className="page-container space-y-4">
      {canPrint && printing && data ? <>
        <style>{PRINT_CSS}</style>
        <MusterRollCall orgName={org?.legalName ?? org?.displayName ?? ''} locationLabel={(locationId ? tree.labelOf(locationId) : '') || nodeName} date={data.date} generatedAt={printedAt} timezone={locationTz} totals={data.totals} entries={rollCall} entryTimezone={entryTimezone} />
      </> : null}
      <div className="space-y-4" data-print-hide>
        <PageHeader title={t('muster.title')} description={t('muster.subtitle')}
          actions={<>
            {data ? <span className="text-xs text-muted-foreground" data-testid="muster-updated">{t('muster.updated', { time: fmtTime(new Date(q.dataUpdatedAt).toISOString(), locationTz) })}</span> : null}
            <Button variant="outline" size="sm" onClick={() => void q.refetch()} disabled={!locationId} aria-label={tc('common.refresh')}><RefreshCw className={q.isFetching ? 'animate-spin' : undefined} /><span className="hidden sm:inline">{tc('common.refresh')}</span></Button>
            {canPrint ? <Button size="sm" onClick={() => { startPrint(); window.print(); }} disabled={!data || data.deviceCount === 0} data-testid="muster-print"><Printer /> {t('muster.print')}</Button> : null}
          </>} />

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full space-y-1 sm:w-72"><Label htmlFor="muster-location">{t('muster.location')}</Label><LocationPicker id="muster-location" value={locationId} onChange={(id) => go(id)} clearable={false} placeholder={t('muster.pickLocation')} /></div>
              <div className="space-y-1"><Label htmlFor="muster-date">{t('muster.date')}</Label><Input id="muster-date" type="date" dir="ltr" className="w-[160px]" value={date ?? data?.date ?? todayIso(locationTz)} onChange={(e) => setDate(ISO_DATE.test(e.target.value) ? e.target.value : null)} /></div>
              {date ? <Button variant="ghost" size="sm" onClick={() => setDate(null)}>{tc('common.today')}</Button> : null}
            </div>
            {crumbs.length ? (
              <nav aria-label={t('muster.path')} className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="muster-path">
                {crumbs.map((c) => <span key={c.id} className="inline-flex items-center gap-1"><button type="button" className="hover:text-foreground hover:underline" onClick={() => go(c.id)}>{tree.nameOf(c)}</button><ChevronRight className="size-3 rtl:rotate-180" aria-hidden /></span>)}
                <span className="font-medium text-foreground" aria-current="location">{nodeName}</span>
              </nav>
            ) : null}
          </CardContent>
        </Card>

        {!locationId ? (tree.isLoading ? <Skeleton className="h-40 w-full" /> : <EmptyState icon={MapPinned} title={t('muster.noLocations')} description={t('muster.noLocationsHint')} />)
          : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          : !data ? <div className="space-y-3" data-testid="muster-loading"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{MUSTER_STATES.map((s) => <Skeleton key={s} className="h-28 w-full" />)}</div><Skeleton className="h-64 w-full" /></div>
          : data.deviceCount === 0 ? (
            <EmptyState icon={Cpu} title={t('muster.noDevices')} description={t('muster.noDevicesHint')}
              action={showDevicesLink ? <Button asChild variant="outline"><Link to="/devices">{t('muster.openDevices')}</Link></Button> : undefined} />
          )
          // keyed: another location or day starts the list from the top, unfiltered
          : <MusterResult key={`${locationId}|${date ?? ''}`} data={data} nodeName={nodeName} tree={tree} onDrill={go} entryTimezone={entryTimezone} />}
      </div>
    </div>
  );
}

/** The totals, the child locations (drill-down) and the people of one location's muster. */
function MusterResult({ data, nodeName, tree, onDrill, entryTimezone }: { data: LocationMusterDto; nodeName: string; tree: LocationTree; onDrill: (locationId: string) => void; entryTimezone: (e: LocationMusterEntryDto) => string }) {
  const { t } = useTranslation(SCHED_NS);
  const { t: tc } = useTranslation();
  const local = useLocalName();
  const [state, setState] = useState<MusterState | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ by: MusterSort; order: 'asc' | 'desc' }>({ by: 'state', order: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const entries = useMemo(() => sortMusterEntries(filterMusterEntries(data.entries, state, search), sort.by, sort.order), [data, state, search, sort]);
  const pageRows = useMemo(() => entries.slice((page - 1) * pageSize, page * pageSize), [entries, page, pageSize]);
  const filtered = !!state || !!search.trim();
  const pickState = (s: MusterState | null) => { setState(s); setPage(1); };

  const columns = useMemo<ColumnDef<LocationMusterEntryDto, unknown>[]>(() => [
    { id: 'employee', header: t('muster.columns.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.displayName}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p></div> },
    { id: 'state', header: t('muster.columns.state'), cell: ({ row }) => <MusterStateBadge state={row.original.state} /> },
    { id: 'time', header: t('muster.columns.time'), cell: ({ row }) => <span className="tnum" dir="ltr">{fmtTime(row.original.punchedAt, entryTimezone(row.original))}</span> },
    { id: 'terminal', header: t('muster.columns.terminal'), cell: ({ row }) => <span className="text-sm">{row.original.deviceName}</span> },
    { id: 'place', header: t('muster.columns.place'), cell: ({ row }) => <span className="text-sm">{row.original.locationName}</span> },
  ], [t, entryTimezone]);

  return (
    <>
      <section aria-label={t('muster.totals')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {MUSTER_STATES.map((s) => <MusterStatTile key={s} state={s} totals={data.totals} active={state === s} onToggle={() => pickState(state === s ? null : s)} />)}
      </section>

      {data.children.length ? (
        <Card>
          <CardHeader><CardTitle>{t('muster.children', { name: nodeName })}</CardTitle><CardDescription>{t('muster.childrenHint')}</CardDescription></CardHeader>
          <CardContent className="px-0 pb-2">
            <div className="overflow-x-auto">
              <Table aria-label={t('muster.children', { name: nodeName })}>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>{t('muster.location')}</TableHead>{MUSTER_STATES.map((s) => <TableHead key={s} className="text-end">{t(`muster.states.${s}`)}</TableHead>)}</TableRow></TableHeader>
                <TableBody>
                  {data.children.map((c) => {
                    const child = tree.byId.get(c.locationId);
                    return (
                      <TableRow key={c.locationId} className="cursor-pointer" onClick={() => onDrill(c.locationId)} data-testid={`muster-child-${c.locationId}`}>
                        <TableCell>
                          <button type="button" className="inline-flex items-center gap-1 font-medium hover:underline" onClick={(e) => { e.stopPropagation(); onDrill(c.locationId); }}>
                            {local(c.name, c.nameAr)}<ChevronRight className="size-3.5 text-muted-foreground rtl:rotate-180" aria-hidden />
                          </button>
                          {child ? <span className="ms-2 text-xs text-muted-foreground">{tree.levelName(child.levelId)}</span> : null}
                        </TableCell>
                        {MUSTER_STATES.map((s) => <TableCell key={s} className="text-end tnum">{fmtNumber(c.totals[s] ?? 0)}</TableCell>)}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <DataTable
        columns={columns} data={pageRows} total={entries.length} page={page} pageSize={pageSize}
        onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
        sort={sort.by} order={sort.order}
        onSort={(id) => { if (!SORTABLE.includes(id)) return; const by = id as MusterSort; setSort((cur) => ({ by, order: cur.by === by && cur.order === 'asc' ? 'desc' : 'asc' })); setPage(1); }}
        getRowId={(e) => e.employeeId}
        emptyTitle={filtered ? tc('common.noResults') : t('muster.noEntries')} emptyDescription={filtered ? tc('common.noResultsHint') : t('muster.noEntriesHint')}
        toolbar={<>
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('muster.search')} aria-label={t('muster.search')} className="h-8 ps-8" />
          </div>
          <Select value={state ?? ALL} onValueChange={(v) => pickState(v === ALL ? null : (v as MusterState))}>
            <SelectTrigger className="h-8 w-40" aria-label={t('muster.columns.state')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>{t('muster.allStates')}</SelectItem>{MUSTER_STATES.map((s) => <SelectItem key={s} value={s}>{t(`muster.states.${s}`)}</SelectItem>)}</SelectContent>
          </Select>
          {filtered ? <Button variant="ghost" size="sm" onClick={() => { setSearch(''); pickState(null); }}><X /> {tc('common.clearFilters')}</Button> : null}
        </>}
        renderCard={(e) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{e.displayName}</span><MusterStateBadge state={e.state} /></div>
            <p className="text-xs text-muted-foreground"><span className="font-mono" dir="ltr">{e.employeeNumber}</span> · <span className="tnum" dir="ltr">{fmtTime(e.punchedAt, entryTimezone(e))}</span> · {e.deviceName} · {e.locationName}</p>
          </div>
        )}
      />
      <p className="text-xs text-muted-foreground">{t('muster.portalNote')}</p>
    </>
  );
}
