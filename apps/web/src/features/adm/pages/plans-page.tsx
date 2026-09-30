import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calculator, Check, Crown, Minus, Pencil, Plus, Tags, Users } from 'lucide-react';
import { MODULE_KEYS, computeInvoiceTotals, planPriceFor, quoteSubscription, subscriptionInvoiceLines, type BillingCycle, type PlatformPlanDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, StatCard } from '@/components/ui';
import { fmtMoney, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePlatformPlans, usePlatformSettings } from '../billing-api';
import { PlanEditorDialog } from '../components/plan-editor-dialog';

type Filter = 'all' | 'active' | 'inactive';

function PlanCard({ plan, currency, onEdit, featured }: { plan: PlatformPlanDto; currency: string; onEdit: () => void; featured: boolean }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const price = planPriceFor(plan.prices, currency);
  const yearly = quoteSubscription({ prices: plan.prices, includedUsers: plan.includedUsers, currency, cycle: 'yearly', seats: plan.includedUsers });
  const limits = plan.limits as Record<string, unknown>;
  return (
    <Card className={cn('flex flex-col', !plan.isActive && 'opacity-60', featured && 'border-primary shadow-md ring-1 ring-primary/30')} data-testid={`plan-${plan.key}`}>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">{plan.name}{featured ? <Crown className="size-4 text-amber-500" aria-label={t('plans.reference')} /> : null}</CardTitle>
          <CardDescription className="font-mono text-xs" dir="ltr">{plan.key}</CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1">
          {plan.isActive ? <Badge variant="success">{t('plans.active')}</Badge> : <Badge variant="neutral">{t('plans.inactive')}</Badge>}
          {plan.isCustom ? <Badge variant="info">{t('plans.custom')}</Badge> : null}
          {plan.trialDays > 0 ? <Badge variant="outline">{t('plans.trialDays', { count: plan.trialDays })}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4 text-sm">
        {plan.description ? <p className="text-muted-foreground">{plan.description}</p> : null}
        <div className="rounded-lg bg-muted/40 p-3">
          {price ? (
            <>
              <p className="text-2xl font-semibold tnum" dir="ltr">{fmtMoney(price.yearly, currency)}<span className="ms-1 text-sm font-normal text-muted-foreground">{t('plans.perYear')}</span></p>
              <p className="text-xs text-muted-foreground tnum">{t('plans.orMonthly', { amount: fmtMoney(price.monthly, currency) })}</p>
              <p className="mt-2 flex items-center gap-1.5 text-xs"><Users className="size-3.5" aria-hidden />{plan.includedUsers ? t('plans.includes', { count: plan.includedUsers }) : t('plans.noIncluded')}</p>
              {price.extraUserYearly > 0 ? <p className="text-xs text-muted-foreground tnum">{t('plans.extraUser', { yearly: fmtMoney(price.extraUserYearly, currency), monthly: fmtMoney(price.extraUserMonthly, currency) })}</p> : null}
              {yearly ? <p className="text-xs text-muted-foreground tnum">{t('plans.perUser', { amount: fmtMoney(yearly.perUserMonthly, currency) })}</p> : null}
            </>
          ) : <p className="font-medium">{plan.isCustom ? t('plans.contactSales') : t('plans.free')}</p>}
        </div>
        <ul className="space-y-1">
          {MODULE_KEYS.map((m) => {
            const on = plan.modules.includes(m);
            return <li key={m} className={cn('flex items-center gap-2 text-xs', !on && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{on ? <Check className="size-3.5 text-emerald-600" aria-hidden /> : <Minus className="size-3.5" aria-hidden />}{tc(`modules.${m}.name`)}</li>;
          })}
        </ul>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {Object.entries(limits).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{t(`plans.limitKeys.${k}`, { defaultValue: k })}</dt><dd className="text-end tnum" dir="ltr">{typeof v === 'number' ? fmtNumber(v) : String(v)}</dd></div>)}
        </dl>
        <div className="mt-auto flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
          <span>{t('plans.subscribers', { count: plan.liveSubscribers, total: plan.subscribers })}</span>
          <Button size="sm" variant="outline" onClick={onEdit}><Pencil /> {t('plans.edit')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The price a tenant would pay: plan × cycle × users, with VAT — the same helpers the invoices use. */
function PricingCalculator({ plans, currency, vatRate }: { plans: PlatformPlanDto[]; currency: string; vatRate: number }) {
  const { t } = useTranslation('adm');
  const priced = plans.filter((p) => p.isActive && planPriceFor(p.prices, currency));
  const [planKey, setPlanKey] = useState(priced.find((p) => p.key === 'professional')?.key ?? priced[0]?.key ?? '');
  const [cycle, setCycle] = useState<BillingCycle>('yearly');
  const plan = priced.find((p) => p.key === planKey) ?? null;
  const [users, setUsers] = useState<number>(plan?.includedUsers ?? 11);
  const quote = plan ? quoteSubscription({ prices: plan.prices, includedUsers: plan.includedUsers, currency, cycle, seats: users }) : null;
  const totals = plan && quote ? computeInvoiceTotals({ lines: subscriptionInvoiceLines({ planName: plan.name, quote }), taxRate: vatRate, currency }) : null;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Calculator className="size-4" aria-hidden /> {t('plans.calculator')}</CardTitle><CardDescription>{t('plans.calculatorHint')}</CardDescription></CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label={t('plans.fields.plan')} htmlFor="calc-plan">
            <Select value={planKey} onValueChange={(v) => { setPlanKey(v); const p = priced.find((x) => x.key === v); if (p?.includedUsers) setUsers(p.includedUsers); }}>
              <SelectTrigger id="calc-plan"><SelectValue /></SelectTrigger>
              <SelectContent>{priced.map((p) => <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          <FormField label={t('plans.fields.cycle')} htmlFor="calc-cycle">
            <Select value={cycle} onValueChange={(v) => setCycle(v as BillingCycle)}><SelectTrigger id="calc-cycle"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="yearly">{t('cycles.yearly')}</SelectItem><SelectItem value="monthly">{t('cycles.monthly')}</SelectItem></SelectContent>
            </Select>
          </FormField>
          <FormField label={t('plans.fields.users')} htmlFor="calc-users"><Input id="calc-users" type="number" min={1} dir="ltr" value={users} onChange={(e) => setUsers(Math.max(1, Number(e.target.value) || 1))} /></FormField>
        </div>
        {quote && totals ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-3 text-sm" data-testid="calculator-result">
            <dt className="text-muted-foreground">{t('plans.calc.base', { count: quote.includedUsers })}</dt><dd className="text-end tnum" dir="ltr">{fmtMoney(quote.base, currency)}</dd>
            <dt className="text-muted-foreground">{t('plans.calc.extra', { count: quote.extraUsers })}</dt><dd className="text-end tnum" dir="ltr">{fmtMoney(quote.extraAmount, currency)}</dd>
            <dt className="text-muted-foreground">{t('plans.calc.vat', { rate: vatRate })}</dt><dd className="text-end tnum" dir="ltr">{fmtMoney(totals.taxAmount, currency)}</dd>
            <dt className="font-semibold">{t('plans.calc.total')}</dt><dd className="text-end font-semibold tnum" dir="ltr">{fmtMoney(totals.total, currency)}</dd>
            <dt className="text-xs text-muted-foreground">{t('plans.calc.perUser')}</dt><dd className="text-end text-xs text-muted-foreground tnum" dir="ltr">{fmtMoney(quote.perUserMonthly, currency)}</dd>
          </dl>
        ) : <p className="text-sm text-muted-foreground">{t('plans.noPricedPlans')}</p>}
      </CardContent>
    </Card>
  );
}

/** Plans & Pricing (Flowza Finance /adm/plans parity): the catalogue tenants subscribe to, with its editor and a calculator. */
export default function AdmPlansPage() {
  const { t } = useTranslation('adm');
  const q = usePlatformPlans();
  const settings = usePlatformSettings();
  const currency = settings.data?.billing.currency ?? 'OMR';
  const vatRate = settings.data?.billing.vatRate ?? 5;
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<PlatformPlanDto | 'new' | null>(null);
  const plans = useMemo(() => q.data ?? [], [q.data]);
  const shown = plans.filter((p) => (filter === 'all' ? true : filter === 'active' ? p.isActive : !p.isActive));
  const live = plans.reduce((a, p) => a + p.liveSubscribers, 0);
  const popular = [...plans].sort((a, b) => b.liveSubscribers - a.liveSubscribers)[0];
  const reference = plans.find((p) => p.key === 'professional');
  const referenceQuote = reference ? quoteSubscription({ prices: reference.prices, includedUsers: reference.includedUsers, currency, cycle: 'yearly', seats: reference.includedUsers }) : null;
  return (
    <div className="page-container">
      <PageHeader title={t('plansPage.title')} description={t('plansPage.subtitle')} actions={<Button size="sm" onClick={() => setEditing('new')}><Plus /> {t('plans.new')}</Button>} />
      {q.isLoading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-72" />)}</div>
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label={t('plans.kpi.plans')} value={`${fmtNumber(plans.filter((p) => p.isActive).length)} / ${fmtNumber(plans.length)}`} icon={Tags} hint={t('plans.kpi.plansHint')} />
              <StatCard label={t('plans.kpi.live')} value={fmtNumber(live)} icon={Users} />
              <StatCard label={t('plans.kpi.popular')} value={popular && popular.liveSubscribers > 0 ? popular.name : '—'} icon={Crown} />
              <StatCard label={t('plans.kpi.reference')} value={referenceQuote ? fmtMoney(referenceQuote.amount, currency) : '—'} hint={reference ? t('plans.kpi.referenceHint', { name: reference.name, count: reference.includedUsers ?? 0 }) : undefined} icon={Calculator} />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('plans.filter')}>
              {(['all', 'active', 'inactive'] as const).map((f) => <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)}>{t(`plans.filters.${f}`)}</Button>)}
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((p) => <PlanCard key={p.id} plan={p} currency={currency} featured={p.key === 'professional'} onEdit={() => setEditing(p)} />)}
            </div>
            <PricingCalculator plans={plans} currency={currency} vatRate={vatRate} />
          </div>
        )}
      {editing ? <PlanEditorDialog plan={editing === 'new' ? null : editing} currency={currency} open onOpenChange={(o) => !o && setEditing(null)} /> : null}
    </div>
  );
}
