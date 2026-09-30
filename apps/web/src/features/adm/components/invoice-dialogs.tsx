import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Plus, Printer, Trash2, Wallet } from 'lucide-react';
import {
  PAYMENT_METHODS, computeInvoiceTotals, planPriceFor, quoteSubscription, subscriptionInvoiceLines,
  type BillingCycle, type BillingInvoiceDto, type CreateInvoiceInput, type InvoiceLineInput, type PaymentKind, type PaymentMethod,
} from '@flowza/contracts';
import { Combobox } from '@/components/forms';
import {
  Badge, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ErrorState, FormField, Input, Select, SelectContent,
  SelectItem, SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea,
} from '@/components/ui';
import { fmtDate, fmtMoney } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { usePlatformOrgs } from '@/features/platform/api';
import { useBillingMutations, useInvoice, usePlatformPlans, usePlatformSettings } from '../billing-api';
import { ReasonDialog } from './reason-dialog';

export function InvoiceStatusBadge({ invoice }: { invoice: Pick<BillingInvoiceDto, 'status' | 'overdue'> }) {
  const { t } = useTranslation('adm');
  if (invoice.status === 'issued' && invoice.overdue) return <Badge variant="danger">{t('billing.statuses.overdue')}</Badge>;
  return <Badge variant={invoice.status === 'paid' ? 'success' : invoice.status === 'void' ? 'neutral' : 'warning'}>{t(`billing.statuses.${invoice.status}`)}</Badge>;
}

const CUSTOM = '__custom__';

/** Issue an invoice: a plan priced for a cycle and a number of users, and / or custom lines (setup, terminals, training …). */
export function CreateInvoiceDialog({ orgId, open, onOpenChange, onCreated }: { orgId?: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (inv: BillingInvoiceDto) => void }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const plans = usePlatformPlans();
  const settings = usePlatformSettings();
  const currency = settings.data?.billing.currency ?? 'OMR';
  const [search, setSearch] = useState('');
  const orgs = usePlatformOrgs(useMemo(() => ({ search: search || undefined, pageSize: 20 }), [search]));
  const { createInvoice } = useBillingMutations();
  const [organizationId, setOrganizationId] = useState<string | null>(orgId ?? null);
  const [planKey, setPlanKey] = useState<string>('professional');
  const [cycle, setCycle] = useState<BillingCycle>('yearly');
  const [seats, setSeats] = useState<number>(11);
  const [periodStart, setPeriodStart] = useState('');
  const [lines, setLines] = useState<InvoiceLineInput[]>([]);
  const [discount, setDiscount] = useState(0);
  const [taxRate, setTaxRate] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [activates, setActivates] = useState(true);
  const vat = taxRate ?? settings.data?.billing.vatRate ?? 5;
  const plan = planKey === CUSTOM ? null : (plans.data ?? []).find((p) => p.key === planKey) ?? null;
  const quote = plan ? quoteSubscription({ prices: plan.prices, includedUsers: plan.includedUsers, currency, cycle, seats }) : null;
  const allLines = [...(plan && quote ? subscriptionInvoiceLines({ planName: plan.name, quote }) : []), ...lines.filter((l) => l.description.trim())];
  const totals = computeInvoiceTotals({ lines: allLines, discount, taxRate: vat, currency });
  const valid = !!organizationId && allLines.length > 0 && (!plan || !!quote || lines.some((l) => l.description.trim()));
  const setLine = (i: number, patch: Partial<InvoiceLineInput>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const submit = () => {
    if (!organizationId) return;
    const input: CreateInvoiceInput = {
      organizationId, discount, taxRate: vat, notes: notes.trim() || undefined,
      lines: lines.filter((l) => l.description.trim()).map((l) => ({ ...l, description: l.description.trim() })),
      ...(plan ? { planKey: plan.key, billingCycle: cycle, seats, activatesSubscription: activates, ...(periodStart ? { periodStart } : {}) } : {}),
    };
    createInvoice.mutate(input, { onSuccess: (inv) => { toast.success(t('billing.issued', { number: inv.invoiceNumber })); onCreated?.(inv); onOpenChange(false); }, onError: toastError });
  };
  const orgOptions = (orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.displayName, description: `${o.companyCode}${o.subscription ? ` · ${o.subscription.planName}` : ''}` }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('billing.newInvoice')}</DialogTitle><DialogDescription>{t('billing.newInvoiceHint')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {!orgId ? (
              <FormField label={t('billing.fields.tenant')} htmlFor="inv-org" required>
                <Combobox id="inv-org" value={organizationId} onChange={setOrganizationId} options={orgOptions} onSearch={setSearch} loading={orgs.isLoading} placeholder={t('billing.pickTenant')} />
              </FormField>
            ) : null}
            <FormField label={t('billing.fields.plan')} htmlFor="inv-plan">
              <Select value={planKey} onValueChange={(v) => { setPlanKey(v); const p = plans.data?.find((x) => x.key === v); if (p?.includedUsers) setSeats(p.includedUsers); }}>
                <SelectTrigger id="inv-plan"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(plans.data ?? []).filter((p) => p.isActive && (planPriceFor(p.prices, currency) || p.isCustom)).map((p) => <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>)}
                  <SelectItem value={CUSTOM}>{t('billing.customInvoice')}</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>
          {plan ? (
            <div className="grid gap-3 sm:grid-cols-4">
              <FormField label={t('billing.fields.cycle')} htmlFor="inv-cycle">
                <Select value={cycle} onValueChange={(v) => setCycle(v as BillingCycle)}><SelectTrigger id="inv-cycle"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="yearly">{t('cycles.yearly')}</SelectItem><SelectItem value="monthly">{t('cycles.monthly')}</SelectItem></SelectContent>
                </Select>
              </FormField>
              <FormField label={t('billing.fields.users')} htmlFor="inv-seats" hint={plan.includedUsers ? t('billing.includedHint', { count: plan.includedUsers }) : undefined}>
                <Input id="inv-seats" type="number" min={1} dir="ltr" value={seats} onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))} />
              </FormField>
              <FormField label={t('billing.fields.periodStart')} htmlFor="inv-start" hint={t('billing.periodHint')}><Input id="inv-start" type="date" dir="ltr" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></FormField>
              <label className="flex items-end gap-2 pb-2 text-sm"><Checkbox checked={activates} onCheckedChange={(c) => setActivates(c === true)} /> {t('billing.activates')}</label>
            </div>
          ) : null}
          {plan && !quote ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('billing.noPlanPrice', { name: plan.name })}</p> : null}
          <div className="space-y-2">
            <div className="flex items-center justify-between"><p className="text-sm font-medium">{t('billing.extraLines')}</p><Button type="button" size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, { description: '', quantity: 1, unitPrice: 0 }])}><Plus /> {t('billing.addLine')}</Button></div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_5rem_7rem_auto] items-end gap-2">
                <Input aria-label={t('billing.fields.description')} placeholder={t('billing.fields.description')} value={l.description} maxLength={300} onChange={(e) => setLine(i, { description: e.target.value })} />
                <Input aria-label={t('billing.fields.quantity')} type="number" min={0} dir="ltr" value={l.quantity} onChange={(e) => setLine(i, { quantity: Math.max(0, Number(e.target.value) || 0) })} />
                <Input aria-label={t('billing.fields.unitPrice')} type="number" min={0} step="0.001" dir="ltr" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Math.max(0, Number(e.target.value) || 0) })} />
                <Button type="button" size="icon" variant="ghost" aria-label={t('billing.removeLine')} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label={`${t('billing.fields.discount')} (${currency})`} htmlFor="inv-discount"><Input id="inv-discount" type="number" min={0} step="0.001" dir="ltr" value={discount} onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))} /></FormField>
            <FormField label={t('billing.fields.vat')} htmlFor="inv-vat"><Input id="inv-vat" type="number" min={0} max={100} step="0.01" dir="ltr" value={vat} onChange={(e) => setTaxRate(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} /></FormField>
            <FormField label={t('billing.fields.notes')} htmlFor="inv-notes"><Textarea id="inv-notes" rows={1} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
          </div>
          <InvoiceLinesTable lines={totals.lines} currency={currency} totals={totals} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={submit} disabled={!valid} loading={createInvoice.isPending}>{t('billing.issue')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InvoiceLinesTable({ lines, currency, totals }: { lines: BillingInvoiceDto['lines']; currency: string; totals: Pick<BillingInvoiceDto, 'subtotal' | 'discount' | 'taxRate' | 'taxAmount' | 'total'> }) {
  const { t } = useTranslation('adm');
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader><TableRow><TableHead>{t('billing.fields.description')}</TableHead><TableHead className="text-end">{t('billing.fields.quantity')}</TableHead><TableHead className="text-end">{t('billing.fields.unitPrice')}</TableHead><TableHead className="text-end">{t('billing.fields.amount')}</TableHead></TableRow></TableHeader>
        <TableBody>
          {lines.length === 0 ? <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground">{t('billing.noLines')}</TableCell></TableRow> : lines.map((l, i) => (
            <TableRow key={i}><TableCell>{l.description}</TableCell><TableCell className="text-end tnum">{l.quantity}</TableCell><TableCell className="text-end tnum" dir="ltr">{fmtMoney(l.unitPrice, currency)}</TableCell><TableCell className="text-end tnum" dir="ltr">{fmtMoney(l.amount, currency)}</TableCell></TableRow>
          ))}
          <TableRow><TableCell colSpan={3} className="text-end text-muted-foreground">{t('billing.subtotal')}</TableCell><TableCell className="text-end tnum" dir="ltr">{fmtMoney(totals.subtotal, currency)}</TableCell></TableRow>
          {totals.discount > 0 ? <TableRow><TableCell colSpan={3} className="text-end text-muted-foreground">{t('billing.fields.discount')}</TableCell><TableCell className="text-end tnum" dir="ltr">−{fmtMoney(totals.discount, currency)}</TableCell></TableRow> : null}
          <TableRow><TableCell colSpan={3} className="text-end text-muted-foreground">{t('billing.vatLine', { rate: totals.taxRate })}</TableCell><TableCell className="text-end tnum" dir="ltr">{fmtMoney(totals.taxAmount, currency)}</TableCell></TableRow>
          <TableRow><TableCell colSpan={3} className="text-end font-semibold">{t('billing.total')}</TableCell><TableCell className="text-end font-semibold tnum" dir="ltr" data-testid="invoice-total">{fmtMoney(totals.total, currency)}</TableCell></TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A printable tax invoice (the browser prints it or saves it as PDF). Every value is escaped. */
function printInvoice(inv: BillingInvoiceDto, t: (k: string, o?: Record<string, unknown>) => string) {
  const w = window.open('', '_blank');
  if (!w) return;
  const seller = inv.seller as Record<string, string | undefined>;
  const customer = inv.customer as Record<string, unknown>;
  const address = Object.values((customer['address'] ?? {}) as Record<string, string>).filter(Boolean).join(', ');
  const money = (n: number) => esc(fmtMoney(n, inv.currency));
  const rows = inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${esc(l.quantity)}</td><td class="n">${money(l.unitPrice)}</td><td class="n">${money(l.amount)}</td></tr>`).join('');
  w.document.write(`<!doctype html><html dir="${document.documentElement.dir || 'ltr'}"><head><meta charset="utf-8"><title>${esc(inv.invoiceNumber)}</title><style>
    body{font-family:system-ui,sans-serif;color:#0f172a;margin:40px;font-size:13px} h1{font-size:22px;margin:0} .muted{color:#64748b}
    .head{display:flex;justify-content:space-between;gap:24px;margin-bottom:24px} table{width:100%;border-collapse:collapse;margin-top:16px}
    th,td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:start} .n{text-align:end;font-variant-numeric:tabular-nums;direction:ltr} .tot td{font-weight:600}
    .box{margin-top:24px;padding:12px;border:1px solid #e2e8f0;border-radius:8px;white-space:pre-wrap}</style></head><body>
    <div class="head"><div><h1>${esc(t('billing.print.title'))}</h1><p class="muted">${esc(inv.invoiceNumber)}</p></div>
    <div><strong>${esc(seller['name'])}</strong><br>${esc(seller['address'])}${seller['vatNumber'] ? `<br>${esc(t('billing.print.vatNo'))}: ${esc(seller['vatNumber'])}` : ''}</div></div>
    <div class="head"><div><span class="muted">${esc(t('billing.print.billTo'))}</span><br><strong>${esc(customer['legalName'])}</strong><br>${esc(customer['companyCode'])}${address ? `<br>${esc(address)}` : ''}</div>
    <div><span class="muted">${esc(t('billing.fields.issueDate'))}</span> ${esc(inv.issueDate)}<br><span class="muted">${esc(t('billing.fields.dueDate'))}</span> ${esc(inv.dueDate ?? '—')}${inv.periodStart ? `<br><span class="muted">${esc(t('billing.fields.period'))}</span> ${esc(inv.periodStart)} – ${esc(inv.periodEnd ?? '')}` : ''}</div></div>
    <table><thead><tr><th>${esc(t('billing.fields.description'))}</th><th class="n">${esc(t('billing.fields.quantity'))}</th><th class="n">${esc(t('billing.fields.unitPrice'))}</th><th class="n">${esc(t('billing.fields.amount'))}</th></tr></thead><tbody>${rows}
    <tr><td colspan="3" class="n">${esc(t('billing.subtotal'))}</td><td class="n">${money(inv.subtotal)}</td></tr>
    ${inv.discount > 0 ? `<tr><td colspan="3" class="n">${esc(t('billing.fields.discount'))}</td><td class="n">−${money(inv.discount)}</td></tr>` : ''}
    <tr><td colspan="3" class="n">${esc(t('billing.vatLine', { rate: inv.taxRate }))}</td><td class="n">${money(inv.taxAmount)}</td></tr>
    <tr class="tot"><td colspan="3" class="n">${esc(t('billing.total'))}</td><td class="n">${money(inv.total)}</td></tr>
    <tr><td colspan="3" class="n">${esc(t('billing.paid'))}</td><td class="n">${money(inv.amountPaid)}</td></tr>
    <tr class="tot"><td colspan="3" class="n">${esc(t('billing.balance'))}</td><td class="n">${money(inv.balance)}</td></tr></tbody></table>
    ${seller['bankDetails'] ? `<div class="box"><strong>${esc(t('billing.print.bank'))}</strong><br>${esc(seller['bankDetails'])}</div>` : ''}
    ${inv.notes ? `<div class="box">${esc(inv.notes)}</div>` : ''}
    <p class="muted" style="margin-top:24px">${esc(seller['platformName'] ?? 'FlowZa Time')} · ${esc(seller['supportEmail'] ?? '')}</p>
    </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

/** One invoice: lines, totals, payments and refunds, and the actions (record a payment or refund, void, print). */
export function InvoiceDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const q = useInvoice(id);
  const { recordPayment, voidInvoice } = useBillingMutations();
  const [kind, setKind] = useState<PaymentKind | null>(null);
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState('');
  const [voiding, setVoiding] = useState(false);
  const inv = q.data;
  const startPayment = (k: PaymentKind) => { setKind(k); setAmount(k === 'payment' ? inv?.balance ?? 0 : inv?.amountPaid ?? 0); setReference(''); setReceivedOn(''); };
  const record = () => {
    if (!inv || !kind) return;
    recordPayment.mutate({ id: inv.id, input: { kind, amount, method, ...(reference.trim() ? { reference: reference.trim() } : {}), ...(receivedOn ? { receivedOn } : {}) } }, {
      onSuccess: (r) => { toast.success(kind === 'payment' ? t('billing.paymentRecorded') : t('billing.refundRecorded')); if (r.status === 'paid' && r.subscriptionAppliedAt) toast.success(t('billing.subscriptionActivated')); setKind(null); },
      onError: toastError,
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[90vh] overflow-y-auto">
        {q.isLoading ? <Skeleton className="h-96 w-full" /> : q.isError || !inv ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2"><span className="font-mono" dir="ltr">{inv.invoiceNumber}</span><InvoiceStatusBadge invoice={inv} /></DialogTitle>
              <DialogDescription>{inv.organizationName ?? (inv.customer['displayName'] as string | undefined)}{inv.planName ? ` · ${inv.planName}${inv.billingCycle && inv.billingCycle !== 'custom' ? ` · ${t(`cycles.${inv.billingCycle}`)}` : ''}${inv.seats ? ` · ${t('billing.users', { count: inv.seats })}` : ''}` : ''}</DialogDescription>
            </DialogHeader>
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-muted-foreground">{t('billing.fields.issueDate')}</dt><dd>{fmtDate(inv.issueDate)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('billing.fields.dueDate')}</dt><dd>{fmtDate(inv.dueDate)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('billing.fields.period')}</dt><dd>{inv.periodStart ? `${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}` : '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('billing.balance')}</dt><dd className="font-semibold tnum" dir="ltr">{fmtMoney(inv.balance, inv.currency)}</dd></div>
            </dl>
            <InvoiceLinesTable lines={inv.lines} currency={inv.currency} totals={inv} />
            {inv.activatesSubscription ? <p className="text-xs text-muted-foreground">{inv.subscriptionAppliedAt ? t('billing.appliedOn', { date: fmtDate(inv.subscriptionAppliedAt.slice(0, 10)) }) : t('billing.willActivate')}</p> : null}
            {inv.voidReason ? <p className="text-sm text-muted-foreground">{t('billing.voidedBecause', { reason: inv.voidReason })}</p> : null}
            <div>
              <p className="mb-2 text-sm font-medium">{t('billing.paymentsTitle')}</p>
              {(inv.payments ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{t('billing.noPayments')}</p> : (
                <ul className="divide-y rounded-lg border text-sm">
                  {inv.payments?.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <Badge variant={p.kind === 'refund' ? 'warning' : 'success'}>{t(`billing.kinds.${p.kind}`)}</Badge>
                      <span className="tnum" dir="ltr">{fmtMoney(p.amount, p.currency)}</span>
                      <span className="text-muted-foreground">{t(`billing.methods.${p.method}`)}{p.reference ? ` · ${p.reference}` : ''}</span>
                      <span className="ms-auto text-xs text-muted-foreground">{fmtDate(p.receivedOn)}{p.recordedByLabel ? ` · ${p.recordedByLabel}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {kind ? (
              <div className="space-y-3 rounded-lg border p-3" data-testid="payment-form">
                <p className="text-sm font-medium">{kind === 'payment' ? t('billing.recordPayment') : t('billing.recordRefund')}</p>
                <div className="grid gap-3 sm:grid-cols-4">
                  <FormField label={`${t('billing.fields.amount')} (${inv.currency})`} htmlFor="pay-amount"><Input id="pay-amount" type="number" min={0} step="0.001" dir="ltr" value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))} /></FormField>
                  <FormField label={t('billing.fields.method')} htmlFor="pay-method">
                    <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}><SelectTrigger id="pay-method"><SelectValue /></SelectTrigger>
                      <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{t(`billing.methods.${m}`)}</SelectItem>)}</SelectContent>
                    </Select>
                  </FormField>
                  <FormField label={t('billing.fields.reference')} htmlFor="pay-ref"><Input id="pay-ref" maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} /></FormField>
                  <FormField label={t('billing.fields.receivedOn')} htmlFor="pay-date"><Input id="pay-date" type="date" dir="ltr" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} /></FormField>
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setKind(null)}>{tc('common.cancel')}</Button>
                  <Button size="sm" onClick={record} disabled={amount <= 0} loading={recordPayment.isPending}>{tc('common.save')}</Button>
                </div>
              </div>
            ) : null}
            <DialogFooter className="flex-wrap">
              <Button variant="outline" onClick={() => printInvoice(inv, t)}><Printer /> {t('billing.print.action')}</Button>
              {inv.status !== 'void' && inv.amountPaid === 0 ? <Button variant="outline" onClick={() => setVoiding(true)}><Ban /> {t('billing.void')}</Button> : null}
              {inv.amountPaid > 0 ? <Button variant="outline" onClick={() => startPayment('refund')}>{t('billing.refund')}</Button> : null}
              {inv.status === 'issued' && inv.balance > 0 ? <Button onClick={() => startPayment('payment')}><Wallet /> {t('billing.recordPayment')}</Button> : null}
            </DialogFooter>
          </>
        )}
      </DialogContent>
      {voiding && inv ? (
        <ReasonDialog open onOpenChange={(o) => !o && setVoiding(false)} destructive loading={voidInvoice.isPending} title={t('billing.voidTitle', { number: inv.invoiceNumber })} description={t('billing.voidBody')} confirmLabel={t('billing.void')}
          onConfirm={(reason) => voidInvoice.mutate({ id: inv.id, input: { reason } }, { onSuccess: () => { toast.success(t('billing.voided')); setVoiding(false); }, onError: toastError })} />
      ) : null}
    </Dialog>
  );
}
