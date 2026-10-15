import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { CalendarRange, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { TIME_AWAY_KINDS, TIME_AWAY_STATUSES, type TimeAwayKind, type TimeAwayRequestDto, type TimeAwayStatus, type TimeAwaySummaryRowDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StatCard } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDate, fmtDateTime, fmtMinutes, fmtNumber, fmtTime, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { shiftMonth } from '@/features/attendance/status';
import { useTimeAwayRequests, useTimeAwaySummary } from '../api';
import { TIME_AWAY_NS } from '../i18n';
import { awayBreakdown, monthRange } from '../model';
import { AwayBar, AwayLegend, TimeAwayKindBadge, TimeAwayStatusBadge } from '../components/badges';

const ALL = '__all__';
const MONTH = /^\d{4}-\d{2}$/;

/**
 * /attendance/time-away (attendance.view, or a line manager's team with attendance.view_team — docs/time-away.md): for a month,
 * each employee's time away from the site during working hours from the calculated days — official duty, personal permission
 * and unapproved time (red: it is the part HR acts on), the days flagged UNAPPROVED_AWAY and the requests still waiting — and
 * below, the requests themselves. A row of the totals narrows the requests to that employee. Everything lives in the address
 * (`month`, `branchId`, `departmentId`, `status`, `kind`, `employeeId`) so a view can be shared.
 */
export default function TimeAwayPage() {
  const { t } = useTranslation(TIME_AWAY_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const table = useServerTable({ pageSize: 25 });
  const f = table.state.filters;
  const currentMonth = todayIso(tz).slice(0, 7);
  const month = f['month'] && MONTH.test(f['month']) ? f['month'] : currentMonth;
  const branchId = f['branchId'] || undefined;
  const departmentId = f['departmentId'] || undefined;
  const summary = useTimeAwaySummary({ month, branchId, departmentId });
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(branchId);
  const rows = summary.data;
  const totals = useMemo(() => (rows ?? []).reduce(
    (acc, r) => ({ away: acc.away + r.awayMinutes, official: acc.official + r.officialDutyMinutes, permission: acc.permission + r.permissionMinutes, unapproved: acc.unapproved + r.unapprovedAwayMinutes, flagged: acc.flagged + (r.unapprovedAwayMinutes > 0 ? 1 : 0), pending: acc.pending + r.pendingRequests }),
    { away: 0, official: 0, permission: 0, unapproved: 0, flagged: 0, pending: 0 },
  ), [rows]);
  const setMonth = (m: string) => table.update({ filters: { month: m === currentMonth ? '' : m } });
  const hasFilters = !!branchId || !!departmentId;
  const loading = summary.isLoading;

  return (
    <div className="page-container space-y-4">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('previousMonth')} onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="rtl:rotate-180" /></Button>
          <Input type="month" value={month} onChange={(e) => MONTH.test(e.target.value) && setMonth(e.target.value)} className="h-8 w-[150px] border-0 shadow-none" dir="ltr" aria-label={t('month')} />
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('nextMonth')} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => setMonth(currentMonth)} disabled={month === currentMonth}><CalendarRange /> {t('thisMonth')}</Button>
        <Combobox value={branchId ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', departmentId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} aria-label={tc('common.branch')} className="h-8 w-44" />
        <Combobox value={departmentId ?? null} onChange={(v) => table.setFilter('departmentId', v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.department')} aria-label={tc('common.department')} className="h-8 w-44" />
        {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { branchId: '', departmentId: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
        <p className="text-sm text-muted-foreground">{fmtDate(`${month}-01`, 'MMMM yyyy')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" data-testid="time-away-totals">
        <StatCard label={t('totals.away')} value={fmtMinutes(totals.away)} loading={loading} />
        <StatCard label={t('totals.official')} value={fmtMinutes(totals.official)} tone="info" loading={loading} />
        <StatCard label={t('totals.permission')} value={fmtMinutes(totals.permission)} tone="warning" loading={loading} />
        <StatCard label={t('totals.unapproved')} value={fmtMinutes(totals.unapproved)} tone={totals.unapproved > 0 ? 'danger' : 'default'} loading={loading} />
        <StatCard label={t('totals.flagged')} value={fmtNumber(totals.flagged)} tone={totals.flagged > 0 ? 'danger' : 'default'} loading={loading} />
        <StatCard label={t('totals.pending')} value={fmtNumber(totals.pending)} tone={totals.pending > 0 ? 'warning' : 'default'} loading={loading} />
      </div>

      <SummarySection key={`${month}|${branchId ?? ''}|${departmentId ?? ''}`} rows={rows} query={summary} onSelect={(r) => table.setFilter('employeeId', r.employeeId)} selectedId={f['employeeId']} />

      <RequestsSection month={month} branchId={branchId} rows={rows} table={table} />
    </div>
  );
}

type SummaryQuery = ReturnType<typeof useTimeAwaySummary>;

/** The month's totals per employee (the API returns them whole, worst unapproved first); pages on the client. */
function SummarySection({ rows, query, onSelect, selectedId }: { rows: TimeAwaySummaryRowDto[] | undefined; query: SummaryQuery; onSelect: (row: TimeAwaySummaryRowDto) => void; selectedId: string | undefined }) {
  const { t } = useTranslation(TIME_AWAY_NS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const pageRows = useMemo(() => rows?.slice((page - 1) * pageSize, page * pageSize), [rows, page, pageSize]);
  const scale = useMemo(() => (rows ?? []).reduce((m, r) => Math.max(m, awayBreakdown(r).total), 0), [rows]);
  const minutes = (n: number, cls?: string) => <span className={cn('tnum', cls)}>{fmtMinutes(n)}</span>;
  const columns = useMemo<ColumnDef<TimeAwaySummaryRowDto, unknown>[]>(() => [
    { id: 'employee', header: t('summary.columns.employee'), cell: ({ row }) => (
      <div className="min-w-0">
        <p className={cn('truncate font-medium', row.original.employeeId === selectedId && 'text-primary')}>{row.original.employeeName}</p>
        <p className="truncate text-xs text-muted-foreground"><span className="font-mono" dir="ltr">{row.original.employeeNumber}</span>{row.original.departmentName ? ` · ${row.original.departmentName}` : ''}</p>
      </div>
    ) },
    { id: 'days', header: t('summary.columns.days'), cell: ({ row }) => <span className="tnum">{row.original.days}</span> },
    { id: 'away', header: t('summary.columns.away'), cell: ({ row }) => minutes(row.original.awayMinutes, 'font-medium') },
    { id: 'official', header: t('summary.columns.official'), cell: ({ row }) => minutes(row.original.officialDutyMinutes) },
    { id: 'permission', header: t('summary.columns.permission'), cell: ({ row }) => minutes(row.original.permissionMinutes) },
    { id: 'unapproved', header: t('summary.columns.unapproved'), cell: ({ row }) => <span data-testid={`unapproved-${row.original.employeeId}`} className={cn('tnum', row.original.unapprovedAwayMinutes > 0 && 'font-semibold text-red-700 dark:text-red-300')}>{fmtMinutes(row.original.unapprovedAwayMinutes)}</span> },
    { id: 'unapprovedDays', header: t('summary.columns.unapprovedDays'), cell: ({ row }) => <span className={cn('tnum', row.original.unapprovedDays > 0 && 'text-red-700 dark:text-red-300')}>{row.original.unapprovedDays}</span> },
    { id: 'pending', header: t('summary.columns.pending'), cell: ({ row }) => (row.original.pendingRequests > 0 ? <Badge variant="warning" className="tnum">{row.original.pendingRequests}</Badge> : <span className="tnum text-muted-foreground">0</span>) },
    { id: 'breakdown', header: t('summary.columns.breakdown'), cell: ({ row }) => <AwayBar breakdown={awayBreakdown(row.original)} scale={scale} className="w-32" /> },
  ], [t, scale, selectedId]);

  return (
    <section aria-labelledby="time-away-summary" className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="time-away-summary" className="text-base font-semibold">{t('summary.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('summary.hint')}</p>
        </div>
        <AwayLegend />
      </div>
      <DataTable
        columns={columns} data={pageRows} total={rows?.length} page={page} pageSize={pageSize}
        onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
        isLoading={query.isLoading || query.isFetching} error={query.error} onRetry={() => void query.refetch()} storageKey="time-away-summary"
        onRowClick={onSelect} emptyTitle={t('summary.empty')} emptyDescription={t('summary.emptyHint')}
        renderCard={(r) => (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.employeeName}</span>{r.pendingRequests > 0 ? <Badge variant="warning" className="tnum">{r.pendingRequests}</Badge> : null}</div>
            <p className="text-xs text-muted-foreground tnum">{t('summary.card', { days: r.days, away: fmtMinutes(r.awayMinutes), official: fmtMinutes(r.officialDutyMinutes), permission: fmtMinutes(r.permissionMinutes) })}</p>
            {r.unapprovedAwayMinutes > 0 ? <p className="text-xs font-medium text-red-700 tnum dark:text-red-300">{t('summary.cardUnapproved', { duration: fmtMinutes(r.unapprovedAwayMinutes), days: r.unapprovedDays })}</p> : null}
            <AwayBar breakdown={awayBreakdown(r)} scale={scale} />
          </div>
        )}
      />
    </section>
  );
}

/** The requests of the month (server-paged), filterable by status and type, or narrowed to one employee from the totals. */
function RequestsSection({ month, branchId, rows, table }: { month: string; branchId: string | undefined; rows: TimeAwaySummaryRowDto[] | undefined; table: ReturnType<typeof useServerTable> }) {
  const { t } = useTranslation(TIME_AWAY_NS);
  const tz = useOrgTimezone();
  const branches = useBranchOptions();
  const tzOf = (id: string | null) => (id ? branches.byId.get(id)?.timezone : undefined) ?? tz;
  const f = table.state.filters;
  const status = (TIME_AWAY_STATUSES as readonly string[]).includes(f['status'] ?? '') ? (f['status'] as TimeAwayStatus) : undefined;
  const kind = (TIME_AWAY_KINDS as readonly string[]).includes(f['kind'] ?? '') ? (f['kind'] as TimeAwayKind) : undefined;
  const employeeId = f['employeeId'] || undefined;
  const pageSize = Math.min(table.state.pageSize, 200);
  const { from, to } = monthRange(month);
  const q = useTimeAwayRequests({ from, to, status, kind, employeeId, branchId, page: table.state.page, pageSize });
  const employeeName = employeeId ? rows?.find((r) => r.employeeId === employeeId)?.employeeName ?? q.data?.data.find((r) => r.employeeId === employeeId)?.employeeName ?? null : null;
  const today = todayIso(tz);

  const returned = (r: TimeAwayRequestDto) => {
    if (r.returnedAt) return fmtTime(r.returnedAt, tzOf(r.branchId));
    const away = r.source === 'step_out' && r.attendanceDate === today && (r.status === 'pending' || r.status === 'approved');
    return away ? <span className="text-amber-700 dark:text-amber-300">{t('requests.notBack')}</span> : '—';
  };
  const columns: ColumnDef<TimeAwayRequestDto, unknown>[] = [
    { id: 'employee', header: t('requests.columns.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName ?? '—'}</p>{row.original.employeeNumber ? <p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p> : null}</div> },
    { id: 'date', header: t('requests.columns.date'), cell: ({ row }) => <span className="whitespace-nowrap tnum">{fmtDate(row.original.attendanceDate)}</span> },
    { id: 'kind', header: t('requests.columns.kind'), cell: ({ row }) => <div className="space-y-0.5"><TimeAwayKindBadge kind={row.original.kind} /><p className="text-xs text-muted-foreground">{t(`sources.${row.original.source}`)}</p></div> },
    { id: 'window', header: t('requests.columns.window'), cell: ({ row }) => <span className="whitespace-nowrap tnum" dir="ltr">{fmtTime(row.original.startsAt, tzOf(row.original.branchId))}–{fmtTime(row.original.endsAt, tzOf(row.original.branchId))}</span> },
    { id: 'returned', header: t('requests.columns.returned'), cell: ({ row }) => <span className="tnum">{returned(row.original)}</span> },
    { id: 'minutes', header: t('requests.columns.minutes'), cell: ({ row }) => <span className="tnum">{fmtMinutes(row.original.minutes)}</span> },
    { id: 'reason', header: t('requests.columns.reason'), cell: ({ row }) => <div className="max-w-xs"><p className="truncate text-sm" title={row.original.reason}>{row.original.reason}</p>{row.original.destination ? <p className="truncate text-xs text-muted-foreground">{t('requests.destination', { destination: row.original.destination })}</p> : null}</div> },
    { id: 'status', header: t('requests.columns.status'), cell: ({ row }) => <TimeAwayStatusBadge status={row.original.status} /> },
    { id: 'decidedBy', header: t('requests.columns.decidedBy'), cell: ({ row }) => (row.original.decidedByName ? <div className="text-sm"><p className="truncate">{row.original.decidedByName}</p>{row.original.decidedAt ? <p className="text-xs text-muted-foreground tnum">{fmtDateTime(row.original.decidedAt, tzOf(row.original.branchId), 'dd MMM, HH:mm')}</p> : null}</div> : <span className="text-muted-foreground">—</span>) },
  ];

  return (
    <section aria-labelledby="time-away-requests" className="space-y-2">
      <div>
        <h2 id="time-away-requests" className="text-base font-semibold">{t('requests.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('requests.hint')}</p>
      </div>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="time-away-requests"
        emptyTitle={t('requests.empty')} emptyDescription={t('requests.emptyHint')}
        toolbar={
          <>
            <Select value={status ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={t('requests.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('requests.allStatuses')}</SelectItem>{TIME_AWAY_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`statuses.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={kind ?? ALL} onValueChange={(v) => table.setFilter('kind', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-48" aria-label={t('requests.kind')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('requests.allKinds')}</SelectItem>{TIME_AWAY_KINDS.map((k) => <SelectItem key={k} value={k}>{t(`kinds.${k}`)}</SelectItem>)}</SelectContent>
            </Select>
            {employeeId ? (
              <Badge variant="secondary" className="h-8 gap-1.5 pe-1 text-sm font-normal" data-testid="time-away-employee-filter">
                {employeeName ? t('requests.forEmployee', { name: employeeName }) : t('requests.columns.employee')}
                <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t('requests.showAll')} onClick={() => table.setFilter('employeeId', undefined)}><X /></Button>
              </Badge>
            ) : null}
          </>
        }
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.employeeName ?? '—'}</span><TimeAwayStatusBadge status={r.status} /></div>
            <div className="flex flex-wrap items-center gap-2"><TimeAwayKindBadge kind={r.kind} /><span className="text-xs text-muted-foreground tnum">{t('requests.card', { date: fmtDate(r.attendanceDate), from: fmtTime(r.startsAt, tzOf(r.branchId)), to: fmtTime(r.endsAt, tzOf(r.branchId)), duration: fmtMinutes(r.minutes) })}</span></div>
            <p className="truncate text-xs text-muted-foreground">{r.reason}</p>
          </div>
        )}
      />
    </section>
  );
}
