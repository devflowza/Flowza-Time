import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { AlertTriangle, CheckCheck, Clock, Mail, MailX, X } from 'lucide-react';
import { EMAIL_KINDS, EMAIL_PROBLEM_STATUSES, EMAIL_STALLED_AFTER_MINUTES, EMAIL_STATUSES, EMAIL_WAITING_STATUSES, type EmailMessageDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StatCard } from '@/components/ui';
import { DateRange } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { SearchBox } from '@/features/organization/components/search-box';
import { useEmailLog, useEmailLogSummary } from '../email-log-api';
import { EmailDetailDialog } from '../components/email-detail-dialog';
import { useReasonText } from '../email-status-utils';
import { EmailStatusBadge } from '../components/email-status';

const ALL = '__all__';
/** The cards' groups, as the `status` filter carries them (comma-separated). */
const WAITING = EMAIL_WAITING_STATUSES.join(',');
const PROBLEMS = EMAIL_PROBLEM_STATUSES.join(',');

/**
 * E-mail activity log (Audit): every invitation and notification e-mail of the organisation — queued, retried, sent, then
 * delivered / bounced once the provider reports back — with the last 7 days at a glance and a warning when e-mails are
 * waiting for a worker that is not sending them (the "Sending…" that never ends) or never left the server (no provider).
 */
export default function EmailLogPage() {
  const { t } = useTranslation('email-log');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const reason = useReasonText();
  const table = useServerTable({ sort: 'createdAt', order: 'desc' });
  const f = table.state.filters;
  const query = useMemo(() => ({
    page: table.state.page, pageSize: table.state.pageSize, sort: table.state.sort, order: table.state.order,
    status: f['status'], kind: f['kind'], search: f['search'], invitationId: f['invitationId'],
    from: f['fromDate'] ? DateTime.fromISO(f['fromDate'], { zone: tz }).startOf('day').toUTC().toISO() ?? undefined : undefined,
    to: f['toDate'] ? DateTime.fromISO(f['toDate'], { zone: tz }).endOf('day').toUTC().toISO() ?? undefined : undefined,
  }), [table.state, f, tz]);
  const q = useEmailLog(query);
  const summary = useEmailLogSummary();
  const s = summary.data;
  const [selected, setSelected] = useState<string | null>(null);
  const hasFilters = Object.keys(f).length > 0;
  const toggleStatus = (status: string) => table.setFilter('status', f['status'] === status ? undefined : status);

  const columns = useMemo<ColumnDef<EmailMessageDto, unknown>[]>(() => [
    { id: 'createdAt', accessorKey: 'createdAt', header: t('columns.time'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, tz, 'dd MMM yyyy, HH:mm')}</span> },
    { id: 'recipient', accessorKey: 'recipient', header: t('columns.recipient'), cell: ({ row }) => (
      <div className="min-w-0">
        <p className="truncate" dir="ltr">{row.original.recipient}</p>
        {row.original.recipientName ? <p className="truncate text-xs text-muted-foreground">{row.original.recipientName}</p> : null}
      </div>
    ) },
    { id: 'subject', header: t('columns.subject'), enableSorting: false, cell: ({ row }) => (
      <div className="min-w-0 max-w-[320px]">
        <p className="truncate" dir="auto">{row.original.subject ?? t(`kinds.${row.original.kind}`)}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground" dir="ltr">{row.original.kind === 'invitation' ? t('kinds.invitation') : row.original.category}</p>
      </div>
    ) },
    { id: 'status', accessorKey: 'status', header: t('columns.status'), cell: ({ row }) => (
      <div className="flex flex-col items-start gap-0.5">
        <EmailStatusBadge message={row.original} />
        {row.original.lastError && ['failed', 'bounced', 'complained', 'retrying', 'delayed', 'skipped'].includes(row.original.status)
          ? <span className="max-w-[260px] truncate text-[11px] text-muted-foreground" title={reason(row.original.lastError) ?? undefined} dir="auto">{reason(row.original.lastError)}</span> : null}
      </div>
    ) },
    { id: 'attempts', header: t('columns.attempts'), enableSorting: false, cell: ({ row }) => <span className="tnum text-xs">{row.original.attempts}</span> },
    { id: 'sentAt', accessorKey: 'sentAt', header: t('columns.sentAt'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum text-muted-foreground">{row.original.sentAt ? fmtDateTime(row.original.sentAt, tz, 'dd MMM, HH:mm') : '—'}</span> },
  ], [t, tz, reason]);

  const waiting = (s?.byStatus.queued ?? 0) + (s?.byStatus.retrying ?? 0);
  const problems = (s?.byStatus.failed ?? 0) + (s?.byStatus.bounced ?? 0) + (s?.byStatus.complained ?? 0);

  return (
    <div className="page-container space-y-4">
      <PageHeader title={t('title')} description={t('subtitle')} />
      {s && s.stalled > 0 ? (
        <div role="alert" data-testid="email-log-stalled" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">{t('banner.stalledTitle', { count: s.stalled, minutes: EMAIL_STALLED_AFTER_MINUTES })}</p>
            <p className="text-xs">{t('banner.stalled', { since: fmtRelative(s.oldestStalledAt) })}</p>
          </div>
        </div>
      ) : null}
      {s && s.consoleSent > 0 ? (
        <div role="alert" data-testid="email-log-console" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{t('banner.console', { count: s.consoleSent })}</p>
        </div>
      ) : null}
      <section aria-label={t('summary.label')} className="space-y-2">
        <p className="text-xs text-muted-foreground">{t('summary.period')}</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={t('summary.sent')} value={fmtNumber(s?.byStatus.sent ?? 0)} icon={Mail} tone="info" loading={summary.isLoading} hint={t('summary.sentHint')} onClick={() => toggleStatus('sent')} />
          <StatCard label={t('summary.delivered')} value={fmtNumber(s?.byStatus.delivered ?? 0)} icon={CheckCheck} tone="success" loading={summary.isLoading} onClick={() => toggleStatus('delivered')} />
          <StatCard label={t('summary.waiting')} value={fmtNumber(waiting)} icon={Clock} tone={s && s.stalled > 0 ? 'warning' : 'default'} loading={summary.isLoading} onClick={() => toggleStatus(WAITING)} />
          <StatCard label={t('summary.problems')} value={fmtNumber(problems)} icon={MailX} tone={problems > 0 ? 'danger' : 'default'} loading={summary.isLoading} hint={t('summary.problemsHint')} onClick={() => toggleStatus(PROBLEMS)} />
        </div>
      </section>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} storageKey="email-log"
        onRowClick={(m) => setSelected(m.id)}
        emptyTitle={t('empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('emptyHint')}
        toolbar={
          <>
            <SearchBox id="email-log-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('filters.searchPlaceholder')} className="relative w-full sm:w-60" />
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={t('columns.status')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>
                <SelectItem value={WAITING}>{t('summary.waiting')}</SelectItem>
                <SelectItem value={PROBLEMS}>{t('summary.problems')}</SelectItem>
                {EMAIL_STATUSES.map((st) => <SelectItem key={st} value={st}>{t(`status.${st}`)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={f['kind'] ?? ALL} onValueChange={(v) => table.setFilter('kind', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={t('columns.type')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.allKinds')}</SelectItem>{EMAIL_KINDS.map((k) => <SelectItem key={k} value={k}>{t(`kinds.${k}`)}</SelectItem>)}</SelectContent>
            </Select>
            <DateRange idPrefix="email-log" from={f['fromDate']} to={f['toDate']} onChange={({ from, to }) => table.update({ filters: { fromDate: from ?? '', toDate: to ?? '' } })} />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
          </>
        }
        renderCard={(m) => (
          <div className="flex items-start gap-3">
            <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" dir="ltr">{m.recipient}</p>
              <p className="truncate text-xs text-muted-foreground" dir="auto">{m.subject ?? t(`kinds.${m.kind}`)} · <span className="tnum">{fmtDateTime(m.createdAt, tz)}</span></p>
            </div>
            <EmailStatusBadge message={m} />
          </div>
        )}
      />
      <p className="text-xs text-muted-foreground">{t('footnote')}</p>
      <EmailDetailDialog id={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
