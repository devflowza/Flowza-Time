import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Hammer, Lock, LockOpen, Wallet, X } from 'lucide-react';
import type { PayrollPeriodDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, fmtDateTime, fmtNumber, todayIso } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { toastJobQueued } from '@/features/employees/job-toast';
import { fmtDays, fmtHm } from '@/features/attendance/status';
import { LockPeriodDialog } from '@/features/attendance/components/period-locks-tab';
import { usePayrollMutations, usePayrollPeriods, usePayrollSummaries } from '../api';
import type { PayrollSummaryDto } from '../types';

const ALL = '__all__';
const periodKey = (p: { periodStart: string; periodEnd: string }) => `${p.periodStart}_${p.periodEnd}`;

/** /payroll?year=&branchId=&period=start_end — periods with lock status and actions; summaries of the selected period below. */
export default function PayrollPage() {
  const { t } = useTranslation('payroll');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const branches = useBranchOptions();
  const [params, setParams] = useSearchParams();
  const thisYear = Number(todayIso(tz).slice(0, 4));
  const year = Number(params.get('year') ?? thisYear) || thisYear;
  const branchId = params.get('branchId') ?? undefined;
  const setParam = (k: string, v: string | undefined) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); n.delete('page'); return n; });
  const periods = usePayrollPeriods({ year, branchId });
  const defaultPeriod = periods.data?.find((p) => p.isCurrent) ?? periods.data?.[0] ?? null;
  const selectedKey = params.get('period') ?? (defaultPeriod ? periodKey(defaultPeriod) : null);
  const selected = periods.data?.find((p) => periodKey(p) === selectedKey) ?? null;
  const page = Number(params.get('page') ?? 1) || 1;
  const pageSize = Number(params.get('pageSize') ?? 25) || 25;
  const status = params.get('status') ?? undefined;
  const search = params.get('search') ?? undefined;
  const sumQuery = useMemo(() => (selected ? { periodStart: selected.periodStart, periodEnd: selected.periodEnd, branchId, status, search, page, pageSize } : {}), [selected, branchId, status, search, page, pageSize]);
  const summaries = usePayrollSummaries(sumQuery, !!selected);
  const { build, finalize } = usePayrollMutations();
  const [lockFor, setLockFor] = useState<PayrollPeriodDto | null>(null);
  const [finalizing, setFinalizing] = useState<PayrollPeriodDto | null>(null);
  const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2];
  const canFinalize = can('payroll.finalize');
  const canLock = can('attendance.lock_period');
  const runBuild = (p: PayrollPeriodDto) => build.mutate({ periodStart: p.periodStart, periodEnd: p.periodEnd, branchId }, { onSuccess: (r) => toastJobQueued(r.jobId, navigate, t('periods.buildQueued')), onError: toastError });

  const columns = useMemo<ColumnDef<PayrollSummaryDto, unknown>[]>(() => [
    { id: 'employee', header: t('summaries.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}{row.original.branchName ? ` · ${row.original.branchName}` : ''}</p></div> },
    { id: 'workingDays', header: t('summaries.workingDays'), cell: ({ row }) => <span className="tnum">{fmtDays(row.original.workingDays)}</span> },
    { id: 'presentDays', header: t('summaries.presentDays'), cell: ({ row }) => <span className="tnum">{fmtDays(row.original.presentDays)}</span> },
    { id: 'absentDays', header: t('summaries.absentDays'), cell: ({ row }) => <span className={cn('tnum', (row.original.absentDays ?? 0) > 0 && 'text-red-700 dark:text-red-300')}>{fmtDays(row.original.absentDays)}</span> },
    { id: 'leaveDays', header: t('summaries.leaveDays'), cell: ({ row }) => <span className="tnum">{fmtDays(row.original.leaveDays)}<span className="text-xs text-muted-foreground"> ({fmtDays(row.original.paidLeaveDays)})</span></span> },
    { id: 'holidayDays', header: t('summaries.holidayDays'), cell: ({ row }) => <span className="tnum">{row.original.holidayDays}</span> },
    { id: 'lateDays', header: t('summaries.late'), cell: ({ row }) => <span className={cn('tnum', row.original.lateDays > 0 && 'text-amber-700 dark:text-amber-300')}>{row.original.lateDays} <span className="text-xs text-muted-foreground">({fmtHm(row.original.lateMinutes)})</span></span> },
    { id: 'missing', header: t('summaries.missingPunchDays'), cell: ({ row }) => <span className="tnum">{row.original.missingPunchDays}</span> },
    { id: 'regular', header: t('summaries.regular'), cell: ({ row }) => <span className="tnum">{fmtHm(row.original.regularMinutes)}</span> },
    { id: 'overtime', header: t('summaries.overtime'), cell: ({ row }) => <span className="tnum" title={t('summaries.overtimeBreakdown', { weeklyOff: fmtHm(row.original.overtimeWeeklyOffMinutes), holiday: fmtHm(row.original.overtimeHolidayMinutes) })}>{fmtHm(row.original.overtimeMinutes)}</span> },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <Badge variant={row.original.status === 'finalized' ? 'success' : 'warning'} dot>{t(`summaries.status.${row.original.status}`, { defaultValue: row.original.status })}</Badge> },
    { id: 'computedAt', header: t('summaries.computedAt'), cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted-foreground tnum">v{row.original.version} · {fmtDateTime(row.original.computedAt, tz)}</span> },
  ], [t, tc, tz]);

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(year)} onValueChange={(v) => setParam('year', v)}>
          <SelectTrigger className="h-8 w-28" aria-label={t('periods.year')}><SelectValue /></SelectTrigger>
          <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
        </Select>
        <Combobox value={branchId ?? null} onChange={(v) => setParam('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={t('periods.allBranches')} className="h-8 w-44" />
      </div>

      <section className="rounded-lg border bg-card shadow-card">
        {periods.isError ? <div className="p-4"><ErrorState error={periods.error} onRetry={() => void periods.refetch()} /></div>
          : periods.isLoading && !periods.data ? <TableSkeleton cols={5} rows={6} />
          : !periods.data || periods.data.length === 0 ? <div className="p-4"><EmptyState icon={Wallet} title={t('periods.empty')} /></div>
          : (
            <Table>
              <TableHeader><TableRow><TableHead>{t('periods.period')}</TableHead><TableHead>{t('periods.range')}</TableHead><TableHead>{t('periods.lock')}</TableHead><TableHead>{t('periods.summaries')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead></TableRow></TableHeader>
              <TableBody className={cn(periods.isFetching && 'opacity-60')}>
                {periods.data.map((p) => {
                  const active = periodKey(p) === selectedKey;
                  return (
                    <TableRow key={periodKey(p)} data-state={active ? 'selected' : undefined} className="cursor-pointer" onClick={() => setParam('period', periodKey(p))}>
                      <TableCell><span className="font-medium">{fmtDate(`${p.periodEnd}`, 'MMMM yyyy')}</span>{p.isCurrent ? <Badge variant="info" className="ms-2">{t('periods.current')}</Badge> : null}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs tnum">{fmtDate(p.periodStart)} → {fmtDate(p.periodEnd)}</TableCell>
                      <TableCell>{p.locked ? <Badge variant="success" dot><Lock className="size-3" /> {t('periods.locked')}</Badge> : <Badge variant="neutral" dot><LockOpen className="size-3" /> {t('periods.open')}</Badge>}{p.lockedAt ? <span className="ms-2 text-xs text-muted-foreground tnum">{fmtDateTime(p.lockedAt, tz)}</span> : null}</TableCell>
                      <TableCell className="text-xs tnum">{p.summaries.total === 0 ? <span className="text-muted-foreground">{t('periods.noSummaries')}</span> : <>{t('periods.summaryCounts', { employees: fmtNumber(p.summaries.employees), draft: fmtNumber(p.summaries.draft), finalized: fmtNumber(p.summaries.finalized) })}</>}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="outline" onClick={() => runBuild(p)} loading={build.isPending && build.variables?.periodStart === p.periodStart}><Hammer /> {t('periods.build')}</Button>
                          {canLock && !p.locked ? <Button size="sm" variant="outline" onClick={() => setLockFor(p)}><Lock /> {t('periods.lockAction')}</Button> : null}
                          {canFinalize ? <Button size="sm" disabled={!p.locked} title={!p.locked ? t('periods.finalizeNeedsLock') : undefined} onClick={() => setFinalizing(p)}><CheckCircle2 /> {t('periods.finalize')}</Button> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
      </section>

      {selected ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{t('summaries.title', { period: fmtDate(selected.periodEnd, 'MMMM yyyy') })}</h2>
            <p className="text-xs text-muted-foreground">{t('summaries.hint')}</p>
          </div>
          <DataTable
            columns={columns} data={summaries.data?.data} total={summaries.data?.meta.total} page={page} pageSize={pageSize}
            onPageChange={(p) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('page', String(p)); return n; })} onPageSizeChange={(s) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('pageSize', String(s)); n.set('page', '1'); return n; })}
            isLoading={summaries.isLoading || summaries.isFetching} error={summaries.error} onRetry={() => void summaries.refetch()} storageKey="payroll-summaries"
            emptyTitle={t('summaries.empty')} emptyDescription={t('summaries.emptyHint')}
            emptyAction={!status && !search ? <Button onClick={() => runBuild(selected)} loading={build.isPending}><Hammer /> {t('periods.build')}</Button> : undefined}
            toolbar={
              <>
                <SearchBox id="pay-search" value={search} onChange={(v) => setParam('search', v)} />
                <Select value={status ?? ALL} onValueChange={(v) => setParam('status', v === ALL ? undefined : v)}>
                  <SelectTrigger className="h-8 w-36" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={ALL}>{t('summaries.allStatuses')}</SelectItem><SelectItem value="draft">{t('summaries.status.draft')}</SelectItem><SelectItem value="finalized">{t('summaries.status.finalized')}</SelectItem></SelectContent>
                </Select>
                {status || search ? <Button variant="ghost" size="sm" onClick={() => setParams((prev) => { const n = new URLSearchParams(prev); n.delete('status'); n.delete('search'); n.delete('page'); return n; })}><X /> {tc('common.clearFilters')}</Button> : null}
              </>
            }
            renderCard={(s) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{s.employeeName}</span><Badge variant={s.status === 'finalized' ? 'success' : 'warning'}>{t(`summaries.status.${s.status}`)}</Badge></div><p className="text-xs text-muted-foreground tnum">{t('summaries.presentDays')} {fmtDays(s.presentDays)} · {t('summaries.regular')} {fmtHm(s.regularMinutes)} · {t('summaries.overtime')} {fmtHm(s.overtimeMinutes)}</p></div>}
          />
        </section>
      ) : null}

      <LockPeriodDialog key={lockFor ? periodKey(lockFor) : 'none'} open={!!lockFor} onOpenChange={(o) => !o && setLockFor(null)} preset={lockFor ? { periodStart: lockFor.periodStart, periodEnd: lockFor.periodEnd, branchId } : undefined} />
      <ConfirmDialog open={!!finalizing} onOpenChange={(o) => !o && setFinalizing(null)} title={t('periods.finalizeTitle', { period: finalizing ? fmtDate(finalizing.periodEnd, 'MMMM yyyy') : '' })} description={t('periods.finalizeHint')} confirmLabel={t('periods.finalize')} loading={finalize.isPending}
        onConfirm={() => { if (!finalizing) return; finalize.mutate({ periodStart: finalizing.periodStart, periodEnd: finalizing.periodEnd, branchId }, { onSuccess: (r) => { toastJobQueued(r.jobId, navigate, t('periods.finalizeQueued')); setFinalizing(null); }, onError: toastError }); }} />
    </div>
  );
}
