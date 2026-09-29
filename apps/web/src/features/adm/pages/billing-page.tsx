import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Banknote, CalendarClock, FileText, Plus, Receipt, TrendingUp, Wallet } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Skeleton, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui';
import { fmtDateTime, fmtMoney, fmtNumber } from '@/lib/format';
import { useBillingSummary } from '../billing-api';
import { CreateInvoiceDialog, InvoiceDialog } from '../components/invoice-dialogs';
import { InvoicesTable, PaymentsTable } from '../components/billing-tables';

const TABS = ['overview', 'invoices', 'payments'] as const;
type Tab = (typeof TABS)[number];

function Overview() {
  const { t } = useTranslation('adm');
  const { t: tp } = useTranslation('platform');
  const q = useBillingSummary();
  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const c = s.currency;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t('billing.kpi.mrr')} value={fmtMoney(s.mrr, c)} icon={TrendingUp} tone="success" hint={t('billing.kpi.mrrHint')} />
        <StatCard label={t('billing.kpi.arr')} value={fmtMoney(s.arr, c)} icon={Banknote} />
        <StatCard label={t('billing.kpi.outstanding')} value={fmtMoney(s.outstanding, c)} icon={Receipt} tone={s.outstanding > 0 ? 'warning' : 'default'} />
        <StatCard label={t('billing.kpi.overdue')} value={`${fmtNumber(s.overdueInvoices)} · ${fmtMoney(s.overdueAmount, c)}`} icon={AlertTriangle} tone={s.overdueInvoices > 0 ? 'danger' : 'default'} />
        <StatCard label={t('billing.kpi.collected')} value={fmtMoney(s.collectedLast30Days, c)} icon={Wallet} />
        <StatCard label={t('billing.kpi.paying')} value={fmtNumber(s.payingSubscriptions)} icon={FileText} />
        <StatCard label={t('billing.kpi.trialing')} value={fmtNumber(s.trialingSubscriptions)} icon={CalendarClock} />
        <StatCard label={t('billing.kpi.unpriced')} value={fmtNumber(s.unpricedSubscriptions)} hint={t('billing.kpi.unpricedHint')} />
      </div>
      <Card>
        <CardHeader><CardTitle>{t('billing.byPlan')}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>{t('billing.fields.plan')}</TableHead><TableHead className="text-end">{t('billing.liveSubscriptions')}</TableHead><TableHead className="text-end">{t('billing.kpi.mrr')}</TableHead></TableRow></TableHeader>
            <TableBody>{s.byPlan.map((p) => <TableRow key={p.planKey}><TableCell>{p.planName}</TableCell><TableCell className="text-end tnum">{fmtNumber(p.subscriptions)}</TableCell><TableCell className="text-end tnum" dir="ltr">{fmtMoney(p.mrr, c)}</TableCell></TableRow>)}</TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('billing.subscriptions')}</CardTitle><CardDescription>{t('billing.subscriptionsHint')}</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{t('billing.fields.tenant')}</TableHead><TableHead>{t('billing.fields.plan')}</TableHead><TableHead>{t('billing.fields.status')}</TableHead><TableHead>{t('billing.fields.cycle')}</TableHead>
              <TableHead className="text-end">{t('billing.fields.users')}</TableHead><TableHead className="text-end">{t('billing.fields.amount')}</TableHead><TableHead className="text-end">{t('billing.kpi.mrr')}</TableHead><TableHead>{t('billing.renews')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {s.subscriptions.map((r) => (
                <TableRow key={r.organizationId}>
                  <TableCell><Link to={`/adm/tenants/${r.organizationId}?tab=billing`} className="font-medium hover:underline">{r.organizationName}</Link><span className="block font-mono text-xs text-muted-foreground" dir="ltr">{r.companyCode}</span></TableCell>
                  <TableCell>{r.planName}</TableCell>
                  <TableCell><Badge variant={r.status === 'active' ? 'success' : r.status === 'trialing' ? 'info' : r.status === 'past_due' ? 'warning' : 'neutral'}>{tp(`subscription.${r.status}`)}</Badge></TableCell>
                  <TableCell>{t(`cycles.${r.billingCycle}`)}</TableCell>
                  <TableCell className="text-end tnum">{r.seats !== null ? fmtNumber(r.seats) : '—'}<span className="block text-xs text-muted-foreground">{t('billing.employeesNow', { count: r.employees })}</span></TableCell>
                  <TableCell className="text-end tnum" dir="ltr">{fmtMoney(r.amount, c)}</TableCell>
                  <TableCell className="text-end tnum" dir="ltr">{fmtMoney(r.mrr, c)}</TableCell>
                  <TableCell className="text-xs">{r.status === 'trialing' ? t('billing.trialEnds', { date: fmtDateTime(r.trialEndsAt, 'Asia/Muscat', 'dd MMM yyyy') }) : fmtDateTime(r.currentPeriodEnd, 'Asia/Muscat', 'dd MMM yyyy')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

/** Subscriptions & Billing (Flowza Finance /adm/billing parity): revenue, invoices and payments across every tenant. */
export default function AdmBillingPage() {
  const { t } = useTranslation('adm');
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="page-container">
      <PageHeader title={t('billing.title')} description={t('billing.subtitle')} actions={<Button size="sm" onClick={() => setCreating(true)}><Plus /> {t('billing.newInvoice')}</Button>} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList>{TABS.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`billing.tabs.${tb}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="overview">{tab === 'overview' ? <Overview /> : null}</TabsContent>
        <TabsContent value="invoices">{tab === 'invoices' ? <InvoicesTable onOpen={(inv) => setOpen(inv.id)} /> : null}</TabsContent>
        <TabsContent value="payments">{tab === 'payments' ? <PaymentsTable /> : null}</TabsContent>
      </Tabs>
      {creating ? <CreateInvoiceDialog open onOpenChange={(o) => !o && setCreating(false)} onCreated={(inv) => { setParams({ tab: 'invoices' }, { replace: true }); setOpen(inv.id); }} /> : null}
      {open ? <InvoiceDialog id={open} open onOpenChange={(o) => !o && setOpen(null)} /> : null}
    </div>
  );
}
