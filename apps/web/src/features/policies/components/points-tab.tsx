import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { ATTENDANCE_POINT_KINDS, type AttendancePointsRowDto, type DisciplineAction } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { useTabTable } from '@/features/organization/use-tab-table';
import { POLICIES_NS } from '../i18n';
import { useAttendancePoints, useAttendancePointsDetail, useEmployeeGroupOptions } from '../api';

const ACTION_TONE: Record<DisciplineAction, 'info' | 'warning' | 'danger'> = { NOTIFY_MANAGER: 'info', VERBAL_WARNING: 'warning', WRITTEN_WARNING: 'warning', FINAL_WARNING: 'danger', HR_REVIEW: 'danger' };
const fmtPoints = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The escalation step an employee reached (or none). */
export function EscalationBadge({ escalation }: { escalation: AttendancePointsRowDto['escalation'] }) {
  const { t } = useTranslation(POLICIES_NS);
  if (!escalation) return <span className="text-xs text-muted-foreground">{t('points.noEscalation')}</span>;
  return <Badge variant={ACTION_TONE[escalation.action]} data-testid="escalation-badge">{t(`points.actions.${escalation.action}`)}</Badge>;
}

function OccurrencesLine({ row }: { row: AttendancePointsRowDto }) {
  const { t } = useTranslation(POLICIES_NS);
  const parts = ATTENDANCE_POINT_KINDS.filter((k) => row.occurrences[k] > 0).map((k) => `${t(`points.kinds.${k}`)} × ${row.occurrences[k]}`);
  return <span className="text-xs text-muted-foreground">{parts.length ? parts.join(' · ') : '—'}</span>;
}

/** One employee's standing: the policy, the window and every event that counts. */
function PointsDetailDrawer({ employeeId, asOf, onOpenChange }: { employeeId: string | null; asOf: string; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation(POLICIES_NS);
  const q = useAttendancePointsDetail(employeeId, asOf);
  const d = q.data;
  return (
    <Dialog open={!!employeeId} onOpenChange={onOpenChange}>
      <DialogContent className="start-auto end-0 top-0 h-full max-h-none w-full max-w-md translate-x-0 translate-y-0 content-start rounded-none rtl:translate-x-0 sm:max-w-md" data-testid="points-drawer">
        <DialogHeader><DialogTitle>{d ? d.displayName : t('points.detailTitle')}</DialogTitle><DialogDescription>{d ? t('points.window', { from: fmtDate(d.windowFrom), to: fmtDate(d.asOf) }) : null}</DialogDescription></DialogHeader>
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          : !d ? <Skeleton className="h-40 w-full" />
          : (
            <div className="space-y-3">
              <dl className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-sm">
                <div><dt className="text-xs text-muted-foreground">{t('points.policy')}</dt><dd className="font-medium">{d.policyName ?? t('points.defaults')}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('points.points')}</dt><dd className="font-semibold tnum">{d.pointsEnabled ? fmtPoints(d.points) : t('points.off')}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('points.escalation')}</dt><dd><EscalationBadge escalation={d.escalation} /></dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('points.next')}</dt><dd className="text-xs">{d.nextEscalation ? t('points.nextLine', { action: t(`points.actions.${d.nextEscalation.action}`), points: fmtPoints(d.nextEscalation.threshold) }) : '—'}</dd></div>
              </dl>
              {!d.pointsEnabled ? <p className="text-sm text-muted-foreground">{t('points.offHint')}</p>
                : d.events.length === 0 ? <EmptyState title={t('points.noEvents')} />
                : (
                  <ul className="divide-y rounded-md border text-sm" data-testid="points-events">
                    {d.events.map((e, i) => (
                      <li key={`${e.date}-${e.kind}-${i}`} className="flex items-center gap-2 px-3 py-2">
                        <span className="w-24 shrink-0 text-xs tnum">{fmtDate(e.date)}</span>
                        <span className="flex-1">{t(`points.kinds.${e.kind}`)}</span>
                        <span className="font-medium tnum">+{fmtPoints(e.points)}</span>
                        <span className="w-28 shrink-0 text-end text-[11px] text-muted-foreground tnum">{t('points.expires', { date: fmtDate(e.expiresOn) })}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          )}
      </DialogContent>
    </Dialog>
  );
}

/** Attendance points & discipline: each employee's points on the as-of date under their policy, and the escalation reached. */
export function PointsTab() {
  const { t } = useTranslation(POLICIES_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const table = useTabTable();
  const f = table.state.filters;
  const asOf = f['asOf'] ?? todayIso(tz);
  const branches = useBranchOptions();
  const departments = useDepartmentOptions(f['branchId'] ?? null);
  const groups = useEmployeeGroupOptions();
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, asOf, branchId: f['branchId'], departmentId: f['departmentId'], employeeGroupId: f['employeeGroupId'], search: f['search'], minPoints: f['minPoints'] }), [table.state.page, table.state.pageSize, asOf, f]);
  const q = useAttendancePoints(query);
  const [open, setOpen] = useState<string | null>(null);

  const columns = useMemo<ColumnDef<AttendancePointsRowDto, unknown>[]>(() => [
    { id: 'employee', header: t('points.employee'), cell: ({ row }) => <div><p className="font-medium">{row.original.displayName}</p><p className="text-xs text-muted-foreground tnum">{row.original.employeeNumber}</p></div> },
    { id: 'policy', header: t('points.policy'), cell: ({ row }) => <span className="text-xs">{row.original.policyName ?? t('points.defaults')}</span> },
    { id: 'points', header: t('points.points'), cell: ({ row }) => row.original.pointsEnabled ? <span className="font-semibold tnum">{fmtPoints(row.original.points)}</span> : <Badge variant="outline" title={t('points.offHint')}>{t('points.off')}</Badge> },
    { id: 'escalation', header: t('points.escalation'), cell: ({ row }) => <EscalationBadge escalation={row.original.escalation} /> },
    { id: 'next', header: t('points.next'), cell: ({ row }) => <span className="text-xs">{row.original.nextEscalation ? t('points.nextLine', { action: t(`points.actions.${row.original.nextEscalation.action}`), points: fmtPoints(row.original.nextEscalation.threshold) }) : '—'}</span> },
    { id: 'occurrences', header: t('points.occurrences'), cell: ({ row }) => <OccurrencesLine row={row.original} /> },
  ], [t]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('points.hint')}</p>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        getRowId={(r) => r.employeeId} onRowClick={(r) => setOpen(r.employeeId)}
        emptyTitle={t('points.empty')} emptyDescription={t('points.emptyHint')}
        toolbar={
          <>
            <Input type="date" dir="ltr" value={asOf} onChange={(e) => e.target.value && table.setFilter('asOf', e.target.value)} className="h-8 w-40" aria-label={t('points.asOf')} title={t('points.asOf')} />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <Combobox value={f['departmentId'] ?? null} onChange={(v) => table.setFilter('departmentId', v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.department')} className="h-8 w-40" />
            <Combobox value={f['employeeGroupId'] ?? null} onChange={(v) => table.setFilter('employeeGroupId', v ?? undefined)} options={groups.options} loading={groups.isLoading} clearable placeholder={t('points.group')} className="h-8 w-40" />
            <Input value={f['search'] ?? ''} onChange={(e) => table.setFilter('search', e.target.value || undefined)} placeholder={tc('common.searchPlaceholder')} aria-label={tc('common.search')} className="h-8 w-44" />
            <Input type="number" min={0} step={0.5} dir="ltr" value={f['minPoints'] ?? ''} onChange={(e) => table.setFilter('minPoints', e.target.value || undefined)} placeholder={t('points.minPoints')} aria-label={t('points.minPoints')} className="h-8 w-32 tnum" />
          </>
        }
        renderCard={(r) => <div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{r.displayName}</p><p className="text-xs text-muted-foreground">{r.policyName ?? t('points.defaults')}</p></div><div className="flex items-center gap-2">{r.pointsEnabled ? <span className="font-semibold tnum">{fmtPoints(r.points)}</span> : <Badge variant="outline">{t('points.off')}</Badge>}<EscalationBadge escalation={r.escalation} /></div></div>}
      />
      <PointsDetailDrawer employeeId={open} asOf={asOf} onOpenChange={(o) => !o && setOpen(null)} />
    </div>
  );
}
