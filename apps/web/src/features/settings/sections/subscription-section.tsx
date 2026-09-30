import { useTranslation } from 'react-i18next';
import { Check, CreditCard, Mail, Minus } from 'lucide-react';
import { MODULE_KEYS, quoteSubscription, type TenantSubscriptionDto } from '@flowza/contracts';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useActiveMembership, useCan, useOrgTimezone } from '@/features/me/use-me';
import { useSubscription, useTenantInvoices } from '../api';
import { SectionSkeleton, SectionError } from '../components/settings-section';

const TONE: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = { active: 'success', trialing: 'info', past_due: 'warning', cancelled: 'danger', expired: 'neutral' };
const USAGE_KEYS = ['employees', 'devices', 'branches', 'users'] as const;

function Usage({ sub }: { sub: TenantSubscriptionDto }) {
  const { t } = useTranslation('settings');
  const keys = USAGE_KEYS.filter((k) => sub.limits[k] !== undefined || sub.usage[k] !== undefined);
  if (keys.length === 0) return null;
  return (
    <Card>
      <CardHeader><CardTitle>{t('subscription.limits')}</CardTitle><CardDescription>{t('subscription.limitsHint')}</CardDescription></CardHeader>
      <CardContent>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {keys.map((k) => {
            const used = sub.usage[k] ?? 0; const limit = sub.limits[k] ?? null;
            const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
            return (
              <li key={k} className="rounded-md border p-3" data-testid={`usage-${k}`}>
                <div className="flex items-center justify-between text-sm"><span className="font-medium">{t(`subscription.limitKeys.${k}`)}</span><span className="tnum text-muted-foreground">{fmtNumber(used)}{limit !== null ? ` / ${fmtNumber(limit)}` : ''}</span></div>
                {pct !== null ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={pct >= 90 ? 'h-full bg-destructive' : 'h-full bg-primary'} style={{ width: `${pct}%` }} aria-hidden /></div> : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function Invoices({ currency }: { currency: string }) {
  const { t } = useTranslation('settings');
  const can = useCan();
  const q = useTenantInvoices(can('organization.manage'));
  if (!can('organization.manage') || q.isError) return null;
  return (
    <Card>
      <CardHeader><CardTitle>{t('subscription.invoices')}</CardTitle><CardDescription>{t('subscription.invoicesHint')}</CardDescription></CardHeader>
      <CardContent>
        {(q.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{q.isLoading ? '…' : t('subscription.noInvoices')}</p> : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>{t('subscription.invoice')}</TableHead><TableHead>{t('subscription.issued')}</TableHead><TableHead>{t('subscription.due')}</TableHead><TableHead className="text-end">{t('subscription.total')}</TableHead><TableHead className="text-end">{t('subscription.balance')}</TableHead><TableHead>{t('subscription.status')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {q.data?.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-xs" dir="ltr">{inv.invoiceNumber}</TableCell><TableCell>{fmtDate(inv.issueDate)}</TableCell><TableCell>{fmtDate(inv.dueDate)}</TableCell>
                    <TableCell className="text-end tnum" dir="ltr">{fmtMoney(inv.total, inv.currency || currency)}</TableCell><TableCell className="text-end tnum" dir="ltr">{fmtMoney(inv.balance, inv.currency || currency)}</TableCell>
                    <TableCell><Badge variant={inv.status === 'paid' ? 'success' : inv.status === 'void' ? 'neutral' : inv.overdue ? 'danger' : 'warning'}>{t(`subscription.invoiceStatuses.${inv.status === 'issued' && inv.overdue ? 'overdue' : inv.status}`)}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Settings → Subscription: the plan, its price, usage, the modules it includes, the other plans and the invoices. */
export default function SubscriptionSection() {
  const { t } = useTranslation('settings');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const membership = useActiveMembership();
  const q = useSubscription();
  if (q.isLoading) return <SectionSkeleton />;
  const missing = q.isError && q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
  if (q.isError && !missing) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  const sub = q.data;
  if (!sub) {
    return <Card><CardHeader><CardTitle>{t('subscription.title')}</CardTitle><CardDescription>{t('subscription.hint')}</CardDescription></CardHeader>
      <CardContent><EmptyState icon={CreditCard} title={t('subscription.unavailable')} description={t('subscription.unavailableHint', { status: membership?.organization.status ?? '—' })} /></CardContent></Card>;
  }
  const currency = sub.billingContact.currency;
  const users = sub.seats ?? sub.includedUsers;
  const contact = sub.billingContact.supportEmail;
  return (
    <>
      <Card>
        <CardHeader><CardTitle>{t('subscription.title')}</CardTitle><CardDescription>{t('subscription.hint')}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs text-muted-foreground">{t('subscription.plan')}</dt><dd className="text-lg font-semibold">{sub.planName}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('subscription.status')}</dt><dd><Badge variant={TONE[sub.status] ?? 'neutral'} dot>{t(`subscription.statuses.${sub.status}`, { defaultValue: sub.status })}</Badge></dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('subscription.cycle')}</dt><dd>{t(`subscription.cycles.${sub.billingCycle}`)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('subscription.users')}</dt><dd className="tnum">{users !== null ? fmtNumber(users) : '—'}</dd></div>
            <div data-testid="subscription-price"><dt className="text-xs text-muted-foreground">{t('subscription.price')}</dt>
              <dd className="tnum" dir="ltr">{sub.price ? fmtMoney(sub.price.amount, currency) : sub.isCustom ? t('subscription.custom') : '—'}</dd>
              {sub.price ? <dd className="text-xs text-muted-foreground">{t('subscription.priceNote', { cycle: t(`subscription.cycles.${sub.billingCycle}`), vat: sub.vatRate, perUser: fmtMoney(sub.price.perUserMonthly, currency) })}</dd> : null}</div>
            <div><dt className="text-xs text-muted-foreground">{t('subscription.trialEnds')}</dt><dd className="tnum">{fmtDateTime(sub.trialEndsAt, tz)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('subscription.periodEnd')}</dt><dd className="tnum">{fmtDateTime(sub.currentPeriodEnd, tz)}</dd></div>
          </dl>
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Mail className="size-4" aria-hidden />{t('subscription.change')} <a className="text-primary underline underline-offset-4" href={`mailto:${contact}`} dir="ltr">{contact}</a></p>
        </CardContent>
      </Card>
      <Usage sub={sub} />
      <Card>
        <CardHeader><CardTitle>{t('subscription.modules')}</CardTitle><CardDescription>{t('subscription.modulesHint')}</CardDescription></CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2">
            {sub.modules.map((m) => (
              <li key={m.key} className={cn('flex items-start gap-2 rounded-md border p-2.5 text-sm', !m.enabled && 'bg-muted/40 text-muted-foreground')} data-testid={`module-${m.key}`}>
                {m.enabled ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> : <Minus className="mt-0.5 size-4 shrink-0" aria-hidden />}
                <span><span className="font-medium">{tc(`modules.${m.key}.name`, { defaultValue: m.name })}</span><span className="block text-xs">{m.enabled ? tc(`modules.${m.key}.description`, { defaultValue: m.description }) : t('subscription.moduleOff')}</span></span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('subscription.plans')}</CardTitle><CardDescription>{t('subscription.plansHint', { vat: sub.vatRate })}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {sub.availablePlans.map((p) => {
            const yearly = quoteSubscription({ prices: p.prices, includedUsers: p.includedUsers, currency, cycle: 'yearly', seats: p.includedUsers });
            const current = p.key === sub.planKey;
            return (
              <div key={p.key} className={cn('flex flex-col gap-2 rounded-lg border p-3', current && 'border-primary ring-1 ring-primary/30')} data-testid={`plan-${p.key}`}>
                <p className="flex items-center justify-between font-semibold">{p.name}{current ? <Badge variant="info">{t('subscription.current')}</Badge> : null}</p>
                <p className="text-xl font-semibold tnum" dir="ltr">{yearly ? fmtMoney(yearly.amount, currency) : p.isCustom ? t('subscription.custom') : '—'}{yearly ? <span className="ms-1 text-xs font-normal text-muted-foreground">{t('subscription.perYear')}</span> : null}</p>
                {p.includedUsers ? <p className="text-xs text-muted-foreground">{t('subscription.includesUsers', { count: p.includedUsers })}</p> : null}
                <ul className="space-y-0.5 text-xs">{MODULE_KEYS.filter((m) => p.modules.includes(m)).map((m) => <li key={m} className="flex items-center gap-1.5"><Check className="size-3 text-emerald-600" aria-hidden />{tc(`modules.${m}.name`)}</li>)}</ul>
              </div>
            );
          })}
        </CardContent>
      </Card>
      <Invoices currency={currency} />
      {sub.billingContact.bankDetails ? (
        <Card><CardHeader><CardTitle>{t('subscription.howToPay')}</CardTitle><CardDescription>{sub.billingContact.sellerName}</CardDescription></CardHeader>
          <CardContent><p className="whitespace-pre-wrap text-sm">{sub.billingContact.bankDetails}</p></CardContent></Card>
      ) : null}
    </>
  );
}
