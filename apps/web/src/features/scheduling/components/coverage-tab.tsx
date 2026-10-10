import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { MapPin, Pencil, Plus, Target, Trash2 } from 'lucide-react';
import { SHIFT_COVERAGE_REPORT_MAX_DAYS, type ShiftCoverageDto, type ShiftCoverageReportDto } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, EmptyState, ErrorState, Input, Label, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useLocationTree } from '@/features/locations/use-location-tree';
import { useCoverage, useCoverageMutations, useCoverageReport } from '../api';
import { SCHED_NS } from '../i18n';
import { coverageColumns, coverageKey } from '../model';
import { CoverageDialog } from './coverage-dialog';

const addDays = (iso: string, n: number) => DateTime.fromISO(iso, { zone: 'utc' }).plus({ days: n }).toISODate() ?? iso;

/** Shifts → Coverage (Enterprise): the minimum head count per branch (or place of a branch) and shift, and the scheduled-vs-required grid. */
export function CoverageTab() {
  const { t } = useTranslation(SCHED_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const canManage = can('shift.manage');
  const branches = useBranchOptions();
  const tree = useLocationTree({ includeArchived: true });
  const targets = useCoverage();
  const { remove } = useCoverageMutations();
  const [dialog, setDialog] = useState<{ open: boolean; target: ShiftCoverageDto | null }>({ open: false, target: null });
  const [deleting, setDeleting] = useState<ShiftCoverageDto | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [from, setFrom] = useState(() => todayIso(tz));
  const [to, setTo] = useState(() => addDays(todayIso(tz), 13));
  const reportBranch = branchId ?? targets.data?.[0]?.branchId ?? null;
  const tooLong = DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days >= SHIFT_COVERAGE_REPORT_MAX_DAYS;
  const report = useCoverageReport({ branchId: tooLong ? null : reportBranch, from, to });
  const branchName = (id: string) => branches.byId.get(id)?.name ?? '—';
  /** A place's path below its branch: the API's label, else the tree's. */
  const placeName = (c: Pick<ShiftCoverageDto, 'locationId' | 'locationName'>) => (c.locationId ? c.locationName || tree.labelOf(c.locationId, { fromBranch: true }) || '—' : '');
  // the targets' own labels name the report's places when the tree cannot (a place the caller cannot see)
  const targetPlaceNames = useMemo(() => new Map((targets.data ?? []).flatMap((c) => (c.locationId && c.locationName ? [[c.locationId, c.locationName] as const] : []))), [targets.data]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2">
          <div><CardTitle>{t('coverage.targets')}</CardTitle><CardDescription>{t('coverage.targetsHint')}</CardDescription></div>
          {canManage ? <Button size="sm" onClick={() => setDialog({ open: true, target: null })}><Plus /> {t('coverage.add')}</Button> : null}
        </CardHeader>
        <CardContent>
          {targets.isLoading ? <Skeleton className="h-24 w-full" />
            : targets.isError ? <ErrorState error={targets.error} onRetry={() => void targets.refetch()} />
            : !targets.data?.length ? <EmptyState icon={Target} title={t('coverage.empty')} description={t('coverage.emptyHint')} />
            : (
              <ul className="divide-y" data-testid="coverage-targets">
                {targets.data.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm font-medium">
                        <span className="truncate">{c.shiftName ?? '—'} · {branchName(c.branchId)}</span>
                        {c.locationId ? <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground" data-testid="coverage-target-location"><span aria-hidden>·</span><MapPin className="size-3.5 shrink-0" aria-hidden /><span className="sr-only">{t('coverage.location')}: </span><span className="truncate">{placeName(c)}</span></span> : null}
                      </p>
                      <p className="flex flex-wrap gap-1 pt-1">{c.weekdays.map((d) => <Badge key={d} variant="outline">{t(`weekdays.${d}`)}</Badge>)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="info">{t('coverage.minimum', { count: c.minHeadcount })}</Badge>
                      {canManage ? <>
                        <Button variant="ghost" size="icon" className="size-8" aria-label={tc('common.edit')} onClick={() => setDialog({ open: true, target: c })}><Pencil /></Button>
                        <Button variant="ghost" size="icon" className="size-8 text-destructive" aria-label={tc('common.delete')} onClick={() => setDeleting(c)}><Trash2 /></Button>
                      </> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader><CardTitle>{t('coverage.report')}</CardTitle><CardDescription>{t('coverage.reportHint')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-56 space-y-1"><Label htmlFor="cov-report-branch">{tc('common.branch')}</Label><Combobox id="cov-report-branch" value={reportBranch} onChange={setBranchId} options={branches.options} loading={branches.isLoading} placeholder={tc('common.branch')} /></div>
            <div className="space-y-1"><Label htmlFor="cov-from">{tc('common.from')}</Label><Input id="cov-from" type="date" dir="ltr" className="w-[160px]" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="cov-to">{tc('common.to')}</Label><Input id="cov-to" type="date" dir="ltr" className="w-[160px]" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
          {tooLong ? <p role="alert" className="text-sm text-destructive">{t('coverage.tooLong', { days: SHIFT_COVERAGE_REPORT_MAX_DAYS })}</p>
            : !reportBranch ? <p className="text-sm text-muted-foreground">{t('coverage.pickBranch')}</p>
            : report.isError ? <ErrorState error={report.error} onRetry={() => void report.refetch()} />
            : !report.data ? <Skeleton className="h-40 w-full" />
            : <CoverageGrid report={report.data} placeNames={targetPlaceNames} />}
        </CardContent>
      </Card>

      <CoverageDialog key={`${dialog.open}-${dialog.target?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} target={dialog.target} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('coverage.deleteTitle')} description={t('coverage.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: () => { toast.success(t('coverage.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}

/**
 * Days × (shift, place): "scheduled / required" per cell. A target on a place of the branch (site, floor, zone…) gets a column of
 * its own, named by the place's path below the branch; the branch-wide column of a shift keeps its plain heading (it reads
 * "Whole branch" only next to place columns of the same shift). A gap is highlighted with the tenant palette's absence colour,
 * a met target with its presence colour (chart tokens — never a fixed colour, docs/design.md §11). `placeNames`: labels of
 * places the location tree cannot name (the targets' own `locationName`).
 */
export function CoverageGrid({ report, placeNames }: { report: ShiftCoverageReportDto; placeNames?: ReadonlyMap<string, string> }) {
  const { t } = useTranslation(SCHED_NS);
  const { labelOf } = useLocationTree({ includeArchived: true });
  const placeLabel = useCallback((id: string) => labelOf(id, { fromBranch: true }) || placeNames?.get(id) || id.slice(0, 8), [labelOf, placeNames]);
  const columns = useMemo(() => coverageColumns(report, placeLabel), [report, placeLabel]);
  const cellsByDay = useMemo(() => new Map(report.days.map((d) => [d.date, new Map(d.cells.map((c) => [coverageKey(c.shiftId, c.locationId), c]))])), [report.days]);
  const gaps = report.days.reduce((n, d) => n + d.cells.filter((c) => c.gap > 0).length, 0);
  if (report.shifts.length === 0) return <EmptyState icon={Target} title={t('coverage.nothingScheduled')} description={t('coverage.nothingScheduledHint')} />;
  return (
    <div className="space-y-2">
      <p className="text-sm" data-testid="coverage-gaps">{gaps > 0 ? t('coverage.gapCount', { count: gaps }) : t('coverage.noGaps')}</p>
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-max border-separate border-spacing-0 text-sm" aria-label={t('coverage.report')}>
          <thead>
            <tr>
              <th scope="col" className="sticky start-0 bg-card px-2 py-1.5 text-start text-xs font-medium text-muted-foreground">{t('coverage.day')}</th>
              {columns.map((col) => (
                <th key={col.key} scope="col" className="px-2 py-1.5 text-center text-xs font-medium" data-testid={`col-${col.key}`}>
                  <span className="block">{col.shift?.name ?? '—'}</span>
                  <span className="font-normal text-muted-foreground tnum" dir="ltr">{col.shift ? (col.shift.startTime && col.shift.endTime ? `${col.shift.startTime}–${col.shift.endTime}` : col.shift.code) : ''}</span>
                  {col.locationId
                    ? <span className="mt-0.5 flex items-center justify-center gap-1 font-normal text-muted-foreground"><MapPin className="size-3 shrink-0" aria-hidden /><span className="sr-only">{t('coverage.location')}: </span><span className="max-w-40 truncate">{placeLabel(col.locationId)}</span></span>
                    : col.besidePlaces ? <span className="mt-0.5 block font-normal text-muted-foreground">{t('coverage.wholeBranch')}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.days.map((d) => (
              <tr key={d.date} className="border-t">
                <th scope="row" className="sticky start-0 whitespace-nowrap bg-card px-2 py-1 text-start text-xs font-medium tnum">{fmtDate(d.date, 'EEE dd MMM')}</th>
                {columns.map((col) => {
                  const c = cellsByDay.get(d.date)?.get(col.key);
                  // branch-wide cells keep their historical test id (cell-<date>-<shift>); a place's adds the place
                  const testId = col.locationId ? `cell-${d.date}-${col.shiftId}-${col.locationId}` : `cell-${d.date}-${col.shiftId}`;
                  if (!c) return <td key={col.key} data-testid={testId} className="px-2 py-1 text-center text-muted-foreground">—</td>;
                  return (
                    <td key={col.key} data-testid={testId}
                      className={cn('px-2 py-1 text-center tnum', c.gap > 0 ? 'bg-chart-absent/15 font-semibold' : c.required > 0 ? 'bg-chart-present/10' : 'text-muted-foreground')}>
                      <span>{c.scheduled} / {c.required}</span>
                      {c.gap > 0 ? <span className="ms-1 text-xs">({t('coverage.gap', { count: c.gap })})</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
