import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { INVOICE_STATUSES, type BillingInvoiceDto } from '@flowza/contracts';
import { Badge, ErrorState, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useInvoices, usePayments } from '../billing-api';
import { InvoiceStatusBadge } from './invoice-dialogs';
import { Pager } from './pager';

const ALL = '__all__';

/** Invoice table (all tenants, or one tenant when `organizationId` is given). */
export function InvoicesTable({ organizationId, onOpen }: { organizationId?: string; onOpen: (inv: BillingInvoiceDto) => void }) {
  const { t } = useTranslation('adm');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState('');
  const query = useMemo(() => ({ page, pageSize: 25, organizationId, status: status === ALL || status === 'overdue' ? undefined : status, overdueOnly: status === 'overdue' ? true : undefined, search: search.trim() || undefined }), [page, organizationId, status, search]);
  const q = useInvoices(query);
  const total = q.data?.meta.totalPages ?? 1;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {!organizationId ? <Input className="h-9 w-56" placeholder={t('billing.searchInvoices')} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label={t('billing.searchInvoices')} /> : null}
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-44" aria-label={t('billing.fields.status')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>{t('billing.allStatuses')}</SelectItem>{INVOICE_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`billing.statuses.${s}`)}</SelectItem>)}<SelectItem value="overdue">{t('billing.statuses.overdue')}</SelectItem></SelectContent>
        </Select>
      </div>
      {q.isLoading ? <Skeleton className="h-48 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data?.data.length ?? 0) === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{t('billing.noInvoices')}</p> : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{t('billing.fields.number')}</TableHead>{!organizationId ? <TableHead>{t('billing.fields.tenant')}</TableHead> : null}<TableHead>{t('billing.fields.issueDate')}</TableHead><TableHead>{t('billing.fields.dueDate')}</TableHead>
              <TableHead className="text-end">{t('billing.total')}</TableHead><TableHead className="text-end">{t('billing.balance')}</TableHead><TableHead>{t('billing.fields.status')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {q.data?.data.map((inv) => (
                <TableRow key={inv.id} className="cursor-pointer" onClick={() => onOpen(inv)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(inv); }}>
                  <TableCell className="font-mono text-xs" dir="ltr">{inv.invoiceNumber}</TableCell>
                  {!organizationId ? <TableCell>{inv.organizationName}</TableCell> : null}
                  <TableCell>{fmtDate(inv.issueDate)}</TableCell><TableCell>{fmtDate(inv.dueDate)}</TableCell>
                  <TableCell className="text-end tnum" dir="ltr">{fmtMoney(inv.total, inv.currency)}</TableCell>
                  <TableCell className="text-end tnum" dir="ltr">{fmtMoney(inv.balance, inv.currency)}</TableCell>
                  <TableCell><InvoiceStatusBadge invoice={inv} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {total > 1 ? <Pager page={page} total={total} onPage={setPage} /> : null}
    </div>
  );
}

export function PaymentsTable({ organizationId }: { organizationId?: string }) {
  const { t } = useTranslation('adm');
  const [page, setPage] = useState(1);
  const q = usePayments(useMemo(() => ({ page, pageSize: 25, organizationId }), [page, organizationId]));
  const total = q.data?.meta.totalPages ?? 1;
  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if ((q.data?.data.length ?? 0) === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{t('billing.noPayments')}</p>;
  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader><TableRow><TableHead>{t('billing.fields.receivedOn')}</TableHead><TableHead>{t('billing.fields.number')}</TableHead><TableHead>{t('billing.fields.kind')}</TableHead><TableHead>{t('billing.fields.method')}</TableHead><TableHead>{t('billing.fields.reference')}</TableHead><TableHead className="text-end">{t('billing.fields.amount')}</TableHead><TableHead>{t('billing.recordedBy')}</TableHead></TableRow></TableHeader>
          <TableBody>
            {q.data?.data.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{fmtDate(p.receivedOn)}</TableCell><TableCell className="font-mono text-xs" dir="ltr">{p.invoiceNumber}</TableCell>
                <TableCell><Badge variant={p.kind === 'refund' ? 'warning' : 'success'}>{t(`billing.kinds.${p.kind}`)}</Badge></TableCell>
                <TableCell>{t(`billing.methods.${p.method}`)}</TableCell><TableCell className="text-xs">{p.reference ?? '—'}</TableCell>
                <TableCell className="text-end tnum" dir="ltr">{p.kind === 'refund' ? '−' : ''}{fmtMoney(p.amount, p.currency)}</TableCell>
                <TableCell className="text-xs" dir="ltr">{p.recordedByLabel ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {total > 1 ? <Pager page={page} total={total} onPage={setPage} /> : null}
    </>
  );
}
