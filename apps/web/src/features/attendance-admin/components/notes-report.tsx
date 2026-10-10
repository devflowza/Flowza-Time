import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, FileBarChart } from 'lucide-react';
import { ATTENDANCE_NOTE_CATEGORIES, ATTENDANCE_NOTE_STATUSES, NOTE_LIST_SCOPES, type AttendanceNoteStatus, type NoteListScope, type NotesReportRowDto } from '@flowza/contracts';
import { Badge, Button, EmptyState, ErrorState, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { Combobox, DateRange, useDebounced } from '@/components/forms';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { saveTextFile } from '@/lib/save-text-file';
import { AttendanceStatusBadge, FlagChips } from '@/features/attendance/components/badges';
import { AR_NS } from '@/features/attendance-review/i18n';
import { AA_NS } from '../i18n';
import { fetchNotesReportCsv, useNotesReport } from '../api';
import { REPORT_MAX_DAYS, impactDays, inclusiveDays, presentFilters } from '../model';

const ALL = '__all';
const PAGE_SIZE = 50;
const NOTE_TONE: Record<AttendanceNoteStatus, 'warning' | 'info' | 'success' | 'danger'> = { pending: 'warning', info_requested: 'info', approved: 'success', excused: 'success', rejected: 'danger' };
const FILTER_KEYS = ['status', 'category', 'branchId', 'search'] as const;

function Impact({ r }: { r: NotesReportRowDto }) {
  const { t } = useTranslation(AA_NS);
  const days = impactDays(r);
  if (r.impact === 'leave') return <span className="text-xs text-destructive">{t('report.impact.leave', { days, type: r.deductedLeaveTypeName ?? r.deductedLeaveTypeCode ?? '' })}</span>;
  if (r.impact === 'lop') return <span className="text-xs text-destructive">{t('report.impact.lop', { days })}</span>;
  return <span className="text-xs text-muted-foreground">{t(`report.impact.${r.impact}`, { days })}</span>;
}

/**
 * The comments & approvals report (HR portal Prompt 6b, Finance ATT-77/78): every reason in a range with its day, category,
 * comment, approval status, reviewer, pay effect, leave charged / loss of pay and the employee's excused count this year.
 * Scope: my queue, my team, or the organisation (oversight keys). CSV with report.export — built, escaped and audited by the API.
 */
export function NotesReport({ oversight }: { oversight: boolean }) {
  const { t } = useTranslation(AA_NS);
  const { t: tr } = useTranslation(AR_NS);
  const orgId = useOrgId();
  const tz = useOrgTimezone();
  const can = useCan();
  const branches = useBranchOptions();
  const today = todayIso(tz);
  const [scope, setScope] = useState<NoteListScope>(oversight ? 'all' : 'mine');
  const [range, setRange] = useState<{ from?: string; to?: string }>({ from: `${today.slice(0, 7)}-01`, to: today });
  const [values, setValues] = useState<Record<string, string | undefined>>({});
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim(), 300);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const scopes = NOTE_LIST_SCOPES.filter((s) => s !== 'all' || oversight);
  const from = range.from ?? today;
  const to = range.to ?? today;
  const days = inclusiveDays(from, to);
  const valid = days > 0 && days <= REPORT_MAX_DAYS;
  const filters = useMemo(() => ({ scope, from, to, ...presentFilters(FILTER_KEYS, { ...values, search: search || undefined }) }), [scope, from, to, values, search]);
  const q = useNotesReport({ ...filters, page, pageSize: PAGE_SIZE }, valid);
  const set = (k: string, v: string | undefined) => { setValues((p) => ({ ...p, [k]: v })); setPage(1); };
  const exportCsv = () => {
    setExporting(true);
    fetchNotesReportCsv(orgId, filters).then((file) => { saveTextFile(file); toast.success(t('report.exported', { count: file.rowCount })); }).catch(toastError).finally(() => setExporting(false));
  };
  const rows = q.data?.data ?? [];
  const meta = q.data?.meta;
  const totals = meta?.totals;

  return (
    <div className="space-y-3" data-testid="notes-report">
      <p className="text-sm text-muted-foreground">{t('report.hint')}</p>
      <div className="flex flex-wrap items-end gap-2">
        {scopes.length > 1 ? (
          <div className="inline-flex rounded-md border bg-card p-0.5 shadow-card" role="group" aria-label={t('report.title')}>
            {scopes.map((s) => <Button key={s} size="sm" variant={s === scope ? 'default' : 'ghost'} aria-pressed={s === scope} onClick={() => { setScope(s); setPage(1); }}>{t(`report.scope.${s}`)}</Button>)}
          </div>
        ) : null}
        <DateRange idPrefix="notes-report" from={range.from} to={range.to} onChange={(r) => { setRange(r); setPage(1); }} />
        <Select value={values['status'] ?? ALL} onValueChange={(v) => set('status', v === ALL ? undefined : v)}>
          <SelectTrigger className="h-8 w-40" aria-label={t('report.filters.status')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>{t('report.filters.allStatuses')}</SelectItem>{ATTENDANCE_NOTE_STATUSES.map((s) => <SelectItem key={s} value={s}>{tr(`notes.status.${s}`)}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={values['category'] ?? ALL} onValueChange={(v) => set('category', v === ALL ? undefined : v)}>
          <SelectTrigger className="h-8 w-44" aria-label={t('report.filters.category')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>{t('report.filters.allCategories')}</SelectItem>{ATTENDANCE_NOTE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{tr(`categories.${c}`)}</SelectItem>)}</SelectContent>
        </Select>
        {scope === 'all' ? <Combobox value={values['branchId'] ?? null} onChange={(v) => set('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={t('report.filters.branch')} className="h-8 w-40" /> : null}
        <Input type="search" value={searchText} onChange={(e) => { setSearchText(e.target.value); setPage(1); }} placeholder={t('report.filters.search')} aria-label={t('report.filters.search')} className="h-8 w-52" />
        {can('report.export') ? <Button size="sm" variant="outline" className="ms-auto" loading={exporting} disabled={!valid} onClick={exportCsv}><Download /> {t('report.export')}</Button> : null}
      </div>
      {!valid ? <p role="alert" className="text-sm text-destructive">{t('report.rangeTooLong')}</p> : null}
      {totals ? (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" data-testid="notes-report-totals">
          {(['total', 'pending', 'approved', 'rejected', 'excused', 'infoRequested', 'lopDays', 'leaveDays'] as const).map((k) => (
            <div key={k} className="rounded-md border bg-card px-3 py-2 shadow-card"><dt className="truncate text-[11px] text-muted-foreground">{t(`report.totals.${k}`)}</dt><dd className="text-lg font-semibold tnum">{totals[k]}</dd></div>
          ))}
        </dl>
      ) : null}
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : valid && q.isLoading ? <TableSkeleton cols={10} rows={5} /> : rows.length === 0 ? (
        valid ? <EmptyState icon={FileBarChart} title={t('report.empty')} description={t('report.emptyHint')} /> : null
      ) : (
        <div className="rounded-xl border bg-card shadow-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>{(['employee', 'date', 'day', 'category', 'comment', 'status', 'reviewedBy', 'payEffect', 'impact', 'excused'] as const).map((c) => <TableHead key={c}>{t(`report.columns.${c}`)}</TableHead>)}</TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid="notes-report-row">
                    <TableCell className="min-w-[160px]"><span className="block font-medium">{r.employeeName}</span><span className="text-xs text-muted-foreground"><span className="font-mono" dir="ltr">{r.employeeNumber}</span>{r.branchName ? ` · ${r.branchName}` : ''}</span>{r.isOversight ? <Badge variant="warning" className="ms-1 text-[10px]">{tr('notes.oversightChip')}</Badge> : null}</TableCell>
                    <TableCell className="whitespace-nowrap tnum">{fmtDate(r.attendanceDate, 'EEE dd MMM yyyy')}</TableCell>
                    <TableCell className="min-w-[130px]">{r.dayStatus ? <span className="flex flex-wrap items-center gap-1"><AttendanceStatusBadge status={r.dayStatus} /><FlagChips flags={r.dayFlags} max={2} size="xs" /></span> : <span className="text-xs text-muted-foreground">{tr('notes.dayUnknown')}</span>}</TableCell>
                    <TableCell className="text-xs">{tr(`categories.${r.category}`)}</TableCell>
                    <TableCell className="max-w-[280px]"><p className="truncate text-sm" title={r.note} dir="auto">{r.note}</p></TableCell>
                    <TableCell><Badge variant={NOTE_TONE[r.status]} dot>{tr(`notes.status.${r.status}`)}</Badge>{r.approvalStatus === 'PENDING' && r.approvalCurrentStep && r.approvalStepCount ? <span className="block text-[11px] text-muted-foreground tnum">{t('report.level', { n: r.approvalCurrentStep, count: r.approvalStepCount })}</span> : null}</TableCell>
                    <TableCell className="text-xs">{r.reviewedByName ? <><span className="block">{r.reviewedByName}</span><span className="block text-muted-foreground">{r.reviewVia ? t(`report.via.${r.reviewVia}`) : null}{r.reviewedAt ? ` · ${fmtDateTime(r.reviewedAt, tz, 'dd MMM')}` : ''}</span>{r.reviewReason ? <span className="block truncate text-muted-foreground" title={r.reviewReason}>{r.reviewReason}</span> : null}</> : '—'}</TableCell>
                    <TableCell className="text-xs tnum">{r.status === 'rejected' && r.payEffectDays !== null ? t('report.payEffect', { days: r.payEffectDays }) : '—'}</TableCell>
                    <TableCell><Impact r={r} /></TableCell>
                    <TableCell className="text-center text-xs tnum">{r.excusedCountYear}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {meta && meta.totalPages > 1 ? (
            <div className="flex items-center justify-end gap-2 border-t px-3 py-2 text-xs">
              <span className="tnum text-muted-foreground">{t('report.page', { page: meta.page, pages: meta.totalPages, total: meta.total })}</span>
              <Button size="icon" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t('report.previous')}><ChevronLeft className="rtl:rotate-180" /></Button>
              <Button size="icon" variant="ghost" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)} aria-label={t('report.next')}><ChevronRight className="rtl:rotate-180" /></Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
