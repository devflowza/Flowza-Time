import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { FileSignature, Inbox, Mail, MailWarning, Send } from 'lucide-react';
import type { StatementListItemDto } from '@flowza/contracts';
import { STATEMENT_STATUSES } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useStatementMutations, useStatements } from '../api';
import { STATUS_BADGE } from '../status';

const ALL = '__all__';

/** /statements?month=&status=&inbox= — issued monthly statements with the manager's approval inbox as a filter. */
export default function StatementsPage() {
  const { t } = useTranslation('statements');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const setParam = (k: string, v: string | undefined) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); n.delete('page'); return n; });

  const inbox = params.get('inbox') === 'true';
  const month = params.get('month') ?? undefined;
  const status = params.get('status') ?? undefined;
  const page = Number(params.get('page') ?? 1) || 1;
  const pageSize = Number(params.get('pageSize') ?? 25) || 25;

  const list = useStatements({ month, status: inbox ? undefined : status, inbox: inbox || undefined, page, pageSize });
  const { issue } = useStatementMutations();
  const [issueOpen, setIssueOpen] = useState(false);
  const previousMonth = DateTime.now().setZone(tz).minus({ months: 1 }).toFormat('yyyy-MM');
  const [issueMonth, setIssueMonth] = useState(previousMonth);
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => DateTime.now().setZone(tz).minus({ months: i + 1 }).toFormat('yyyy-MM')), [tz]);

  const columns = useMemo<ColumnDef<StatementListItemDto, unknown>[]>(() => [
    {
      id: 'employee', header: t('list.employee'),
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.original.employeeName}</p>
          <p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}{row.original.departmentName ? ` · ${row.original.departmentName}` : ''}</p>
        </div>
      ),
    },
    { id: 'period', header: t('list.period'), cell: ({ row }) => <span className="whitespace-nowrap tnum" dir="ltr">{row.original.periodStart.slice(0, 7)}</span> },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <Badge variant={STATUS_BADGE[row.original.status]} dot>{t(`status.${row.original.status}`)}</Badge> },
    {
      id: 'email', header: t('list.email'),
      cell: ({ row }) => row.original.emailError
        ? <span className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-300"><MailWarning className="size-3.5" aria-hidden />{row.original.emailError === 'NO_EMAIL' ? t('list.noEmail') : t('list.emailFailed')}</span>
        : row.original.emailSentAt
          ? <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Mail className="size-3.5" aria-hidden />{fmtDateTime(row.original.emailSentAt, tz)}</span>
          : <span className="text-xs text-muted-foreground">—</span>,
    },
    { id: 'comments', header: t('list.comments'), cell: ({ row }) => <span className={cn('tnum', row.original.commentCount > 0 && 'font-medium text-amber-700 dark:text-amber-300')}>{row.original.commentCount || ''}</span> },
    {
      id: 'signed', header: t('list.signed'),
      cell: ({ row }) => row.original.signedName
        ? <span className="flex items-center gap-1.5 text-xs"><FileSignature className="size-3.5 text-emerald-600" aria-hidden /><span className="truncate">{row.original.signedName}</span></span>
        : <span className="text-xs text-muted-foreground">—</span>,
    },
    { id: 'approver', header: t('list.approver'), cell: ({ row }) => <span className="truncate text-xs text-muted-foreground">{row.original.approverName ?? ''}</span> },
    { id: 'open', header: '', cell: ({ row }) => <Button asChild size="sm" variant="ghost"><Link to={`/statements/${row.original.id}`}>{tc('common.view')}</Link></Button> },
  ], [t, tc, tz]);

  return (
    <div className="page-container space-y-5">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={can('statement.issue') ? (
          <Button onClick={() => { setIssueMonth(previousMonth); setIssueOpen(true); }}><Send className="size-4" aria-hidden /> {t('issue.button')}</Button>
        ) : undefined}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant={inbox ? 'default' : 'outline'} size="sm" onClick={() => setParam('inbox', inbox ? undefined : 'true')}>
          <Inbox className="size-4" aria-hidden /> {t('list.inboxFilter')}
        </Button>
        <Select value={month ?? ALL} onValueChange={(v) => setParam('month', v === ALL ? undefined : v)}>
          <SelectTrigger className="h-8 w-36" aria-label={t('list.period')}><SelectValue placeholder={t('list.allMonths')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('list.allMonths')}</SelectItem>
            {months.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        {!inbox ? (
          <Select value={status ?? ALL} onValueChange={(v) => setParam('status', v === ALL ? undefined : v)}>
            <SelectTrigger className="h-8 w-44" aria-label={tc('common.status')}><SelectValue placeholder={t('list.allStatuses')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('list.allStatuses')}</SelectItem>
              {STATEMENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        data={list.data?.data}
        total={list.data?.meta.total}
        page={page}
        pageSize={pageSize}
        onPageChange={(p) => setParam('page', String(p))}
        onPageSizeChange={(s) => setParam('pageSize', String(s))}
        isLoading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        emptyTitle={inbox ? t('list.inboxEmpty') : t('list.empty')}
        emptyDescription={inbox ? t('list.inboxEmptyHint') : t('list.emptyHint')}
        onRowClick={(row) => navigate(`/statements/${row.id}`)}
      />

      <ConfirmDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        title={t('issue.title')}
        description={t('issue.description')}
        confirmLabel={t('issue.confirm')}
        loading={issue.isPending}
        onConfirm={() => issue.mutate({ month: issueMonth }, {
          onSuccess: (r) => { setIssueOpen(false); toastJobQueued(r.jobId, navigate, t('issue.queued', { month: r.month }), { to: null }); },
          onError: toastError,
        })}
      >
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t('issue.monthLabel')}</p>
          <Select value={issueMonth} onValueChange={setIssueMonth}>
            <SelectTrigger className="h-9 w-40" aria-label={t('issue.monthLabel')}><SelectValue /></SelectTrigger>
            <SelectContent>{months.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('issue.hint')}</p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
