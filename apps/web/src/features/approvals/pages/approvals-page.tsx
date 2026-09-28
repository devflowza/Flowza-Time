import { useMemo, useState } from 'react';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, Download, FileText, History, Inbox, Settings2, UserRoundCheck, X } from 'lucide-react';
import { APPROVAL_ENTITIES, type ApprovalEntity, type ApprovalInboxScope, type ApprovalRequestDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fmtDateTime, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useMe, useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { SearchBox } from '@/features/organization/components/search-box';
import { useBranchOptions } from '@/features/organization/lookups';
import { useServerTable } from '@/hooks/use-server-table';
import { downloadApprovalHistory, useApprovalAccess, useApprovalInbox, useApprovalMutations, useDelegations, useMyApprovalRequests, type DecisionKind, type InboxView } from '../api';
import { DecisionDialog } from '../components/decision-dialog';
import { RequestDialog } from '../components/request-detail';
import { ApprovalContext, EntityIcon, LevelLabel, RequestStatusBadge } from '../components/parts';

/** Pending and History are the approver's inbox; "My requests" lists what the caller filed or what is about them. */
type PageView = InboxView | 'requests';
const VIEWS: readonly PageView[] = ['pending', 'history', 'requests'];
const SCOPES: readonly ApprovalInboxScope[] = ['mine', 'team', 'all'];
/** Entity types with a live document behind them today; the others appear only once a request of theirs exists. */
const FILTER_TYPES: readonly ApprovalEntity[] = ['ATTENDANCE_CORRECTION', 'LEAVE'];

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={cn('h-8 rounded-full border px-3 text-xs font-medium transition-colors', active ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}>{children}</button>;
}

/**
 * /approvals — the unified inbox (engine v2), open to every active member (the API scopes the rows). Pending | History |
 * My requests; scope Mine (my queue: levels waiting for me or for the approvers I cover for), My team (my direct reports'
 * requests — team keys), Everyone (organisation-wide keys); a type filter; a request opens in a side panel with its levels
 * and timeline (deep link: ?request=<id>).
 */
export default function ApprovalsPage() {
  const { t } = useTranslation('approvals');
  const tz = useOrgTimezone();
  const access = useApprovalAccess();
  const myId = useMe().data?.user.id;
  const branches = useBranchOptions();
  const table = useServerTable({ pageSize: 25 });
  const f = table.state.filters;
  const view: PageView = (VIEWS as readonly string[]).includes(f['view'] ?? '') ? (f['view'] as PageView) : 'pending';
  const requestsView = view === 'requests';
  const inboxView: InboxView = view === 'history' ? 'history' : 'pending';
  const allowedScopes = SCOPES.filter((s) => s === 'mine' || (s === 'team' && access.team) || (s === 'all' && access.orgWide));
  const scope: ApprovalInboxScope = (allowedScopes as readonly string[]).includes(f['scope'] ?? '') ? (f['scope'] as ApprovalInboxScope) : 'mine';
  const entityType = (APPROVAL_ENTITIES as readonly string[]).includes(f['entityType'] ?? '') ? (f['entityType'] as ApprovalEntity) : undefined;
  const search = f['search'] || undefined;
  const openId = f['request'] ?? null;
  const inbox = useApprovalInbox({ scope, view: inboxView, entityType, search, page: table.state.page, pageSize: table.state.pageSize }, !requestsView);
  const myRequests = useMyApprovalRequests({ page: table.state.page, pageSize: table.state.pageSize, entityType }, requestsView);
  const q = requestsView ? myRequests : inbox;
  const orgId = useOrgId();
  const can = useCan();
  const [exporting, setExporting] = useState(false);
  const exportCsv = () => { setExporting(true); downloadApprovalHistory(orgId, { scope, entityType, search }).catch(toastError).finally(() => setExporting(false)); };
  const delegations = useDelegations('mine');
  const [decision, setDecision] = useState<{ request: ApprovalRequestDto | null; kind: DecisionKind }>({ request: null, kind: 'APPROVE' });
  // bulk approval (Finance ATT-95): the API decides each selected request through the engine and reports what it refused
  const [selection, setSelection] = useState<RowSelectionState>({});
  // a selection belongs to the page it was made on: a new view, scope, filter or page starts empty
  const selectionKey = `${view}|${scope}|${entityType ?? ''}|${search ?? ''}|${table.state.page}|${table.state.pageSize}`;
  const [selectionFor, setSelectionFor] = useState(selectionKey);
  if (selectionFor !== selectionKey) { setSelectionFor(selectionKey); setSelection({}); }
  const { bulkDecide } = useApprovalMutations();
  // each line names the level the caller saw on that row (review P1-2): a level that moved on meanwhile is refused
  const approveSelected = (ids: string[]) => bulkDecide.mutate({ items: ids.flatMap((id) => { const row = q.data?.data.find((r) => r.id === id); return row ? [{ requestId: id, stepNo: row.currentStep }] : []; }), decision: 'APPROVE' }, {
    onSuccess: (res) => {
      setSelection({});
      if (res.succeeded) toast.success(t('bulk.approved', { count: res.succeeded }));
      const firstRefusal = res.results.find((x) => !x.ok);
      if (firstRefusal) toast.error(t('bulk.refused', { count: res.failed }), { description: firstRefusal.message ?? undefined });
    },
    onError: toastError,
  });
  const tzOf = useMemo(() => (branchId: string | null) => (branchId ? branches.byId.get(branchId)?.timezone : undefined) ?? tz, [branches.byId, tz]);
  const today = todayIso(tz);
  const covering = (delegations.data ?? []).filter((d) => d.delegateUserId === myId && d.isActive && d.startsOn <= today && d.endsOn >= today).map((d) => d.delegatorName ?? '—');

  const columns = useMemo<ColumnDef<ApprovalRequestDto, unknown>[]>(() => [
    { id: 'request', header: t('columns.request'), cell: ({ row }) => { const r = row.original; return (
      <div className="flex min-w-0 items-center gap-2.5">
        <EntityIcon entityType={r.entityType} />
        <div className="min-w-0"><p className="truncate font-medium">{r.employeeName ?? '—'}</p><p className="truncate text-xs text-muted-foreground">{t(`entity.${r.entityType}`)} <span className="font-mono" dir="ltr">{r.employeeNumber}</span></p></div>
      </div>
    ); } },
    { id: 'details', header: t('columns.details'), cell: ({ row }) => <ApprovalContext context={row.original.context} timezone={tzOf(row.original.branchId)} compact /> },
    { id: 'requester', header: t('columns.requester'), cell: ({ row }) => <div className="text-xs"><p>{row.original.requestedByName ?? '—'}</p><p className="text-muted-foreground tnum">{fmtDateTime(row.original.createdAt, tz)}</p></div> },
    { id: 'level', header: t('columns.level'), cell: ({ row }) => <div className="space-y-1"><LevelLabel request={row.original} />{row.original.infoRequestedAt && row.original.status === 'PENDING' ? <Badge variant="warning">{t('inbox.waitingForAnswer')}</Badge> : null}</div> },
    ...(view !== 'pending' ? [
      { id: 'status', header: t('columns.status'), cell: ({ row }) => <RequestStatusBadge status={row.original.status} /> } as ColumnDef<ApprovalRequestDto, unknown>,
      { id: 'decided', header: t('columns.decided'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{row.original.completedAt ? fmtDateTime(row.original.completedAt, tz) : '—'}</span> } as ColumnDef<ApprovalRequestDto, unknown>,
    ] : []),
    { id: 'actions', header: '', cell: ({ row }) => { const r = row.original; return (
      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
        {r.abilities.actingAsDelegateOf ? <Badge variant="info" className="hidden lg:inline-flex">{t('inbox.delegateOf', { name: r.steps.flatMap((s) => s.actors).find((a) => a.userId === r.abilities.actingAsDelegateOf)?.userName ?? '—' })}</Badge> : null}
        {r.abilities.canDecide ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setDecision({ request: r, kind: 'REJECT' })}><X /> {t('actions.reject')}</Button>
            <Button size="sm" onClick={() => setDecision({ request: r, kind: 'APPROVE' })}><Check /> {t('actions.approve')}</Button>
          </>
        ) : r.status === 'PENDING' && r.requestedBy === myId ? <Badge variant="outline" title={t('inbox.ownRequestHint')}>{t('inbox.ownRequest')}</Badge>
          : r.status === 'PENDING' && r.subjectUserId === myId ? <Badge variant="outline" title={t('inbox.aboutYouHint')}>{t('inbox.aboutYou')}</Badge>
          : r.status === 'PENDING' && scope !== 'mine' ? <span className="text-xs text-muted-foreground">{t('inbox.notYourTurn')}</span> : null}
      </div>
    ); } },
  ], [t, tz, tzOf, view, scope, myId, setDecision]);

  const emptyTitle = requestsView ? t('inbox.requestsEmpty') : view === 'history' ? t('inbox.historyEmpty') : scope === 'team' ? t('inbox.teamEmpty') : scope === 'all' ? t('inbox.allEmpty') : t('inbox.empty');
  const emptyDescription = requestsView ? t('inbox.requestsEmptyHint') : view === 'history' ? t('inbox.historyEmptyHint') : t('inbox.emptyHint');
  return (
    <div className="page-container space-y-4">
      <PageHeader title={t('title')} description={t('subtitle')} actions={
        <div className="flex flex-wrap gap-2">
          {access.delegate ? <Link to="/approvals/delegations" className={buttonVariants({ variant: 'outline', size: 'sm' })}><UserRoundCheck /> {t('actions.delegations')}</Link> : null}
          {access.configure ? <Link to="/approvals/workflows" className={buttonVariants({ variant: 'outline', size: 'sm' })}><Settings2 /> {t('actions.workflows')}</Link> : null}
        </div>
      } />
      {covering.length ? <p className="rounded-md border bg-muted/40 p-2 text-sm" role="status">{t('inbox.delegateBanner', { names: covering.join(', ') })}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={view} onValueChange={(v) => table.setFilter('view', v === 'pending' ? undefined : v)}>
          <TabsList aria-label={t('title')}>
            <TabsTrigger value="pending"><Inbox className="me-1.5 size-4" /> {t('view.pending')}</TabsTrigger>
            <TabsTrigger value="history"><History className="me-1.5 size-4" /> {t('view.history')}</TabsTrigger>
            <TabsTrigger value="requests"><FileText className="me-1.5 size-4" /> {t('view.requests')}</TabsTrigger>
          </TabsList>
        </Tabs>
        {allowedScopes.length > 1 && !requestsView ? (
          <div className="flex items-center gap-1.5" role="group" aria-label={t('scope.label')}>
            {allowedScopes.map((s) => <Chip key={s} active={scope === s} onClick={() => table.setFilter('scope', s === 'mine' ? undefined : s)}>{t(`scope.${s}`)}</Chip>)}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('entityFilter.label')}>
          <Chip active={!entityType} onClick={() => table.setFilter('entityType', undefined)}>{t('entityFilter.all')}</Chip>
          {APPROVAL_ENTITIES.filter((e) => FILTER_TYPES.includes(e) || e === entityType).map((e) => <Chip key={e} active={entityType === e} onClick={() => table.setFilter('entityType', e)}>{t(`entity.${e}`)}</Chip>)}
        </div>
        {!requestsView ? <SearchBox id="approvals-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('inbox.searchPlaceholder')} className="relative w-full sm:ms-auto sm:w-64" /> : null}
        {view === 'history' && can('report.export') ? <Button size="sm" variant="outline" loading={exporting} onClick={exportCsv}><Download /> {t('actions.exportCsv')}</Button> : null}
      </div>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        onRowClick={(r) => table.update({ filters: { request: r.id } }, false)}
        getRowId={(r) => r.id}
        {...(view === 'pending' ? { selection, onSelectionChange: setSelection, bulkActions: (ids: string[]) => <Button size="sm" loading={bulkDecide.isPending} onClick={() => approveSelected(ids)}><Check /> {t('bulk.approveSelected')}</Button> } : {})}
        emptyTitle={emptyTitle} emptyDescription={emptyDescription}
        renderCard={(r) => (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2"><EntityIcon entityType={r.entityType} /><span className="truncate font-medium">{r.employeeName ?? '—'}</span></span>{view !== 'pending' ? <RequestStatusBadge status={r.status} /> : <LevelLabel request={r} />}</div>
            <ApprovalContext context={r.context} timezone={tzOf(r.branchId)} compact />
            {r.abilities.canDecide ? <div className="flex gap-2"><Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setDecision({ request: r, kind: 'REJECT' }); }}><X /> {t('actions.reject')}</Button><Button size="sm" onClick={(e) => { e.stopPropagation(); setDecision({ request: r, kind: 'APPROVE' }); }}><Check /> {t('actions.approve')}</Button></div>
              : r.status === 'PENDING' && r.requestedBy === myId ? <p className="text-xs text-muted-foreground">{t('inbox.ownRequestHint')}</p> : null}
          </div>
        )}
      />
      <DecisionDialog key={`${decision.request?.id ?? ''}-${decision.kind}`} request={decision.request} decision={decision.kind} timezone={tzOf(decision.request?.branchId ?? null)} onClose={() => setDecision((d) => ({ ...d, request: null }))} />
      <RequestDialog requestId={openId} onClose={() => table.update({ filters: { request: '' } }, false)} />
    </div>
  );
}
