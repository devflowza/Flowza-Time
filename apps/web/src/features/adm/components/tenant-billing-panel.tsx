import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { InvoicesTable, PaymentsTable } from './billing-tables';
import { CreateInvoiceDialog, InvoiceDialog } from './invoice-dialogs';

/** Tenant → Billing (Flowza Finance tenant Payments tab parity): the tenant's invoices and payments, and issuing a new invoice. */
export function TenantBillingPanel({ orgId }: { orgId: string }) {
  const { t } = useTranslation('adm');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div><CardTitle>{t('billing.invoicesTitle')}</CardTitle><CardDescription>{t('billing.tenantInvoicesHint')}</CardDescription></div>
          <Button size="sm" onClick={() => setCreating(true)}><Plus /> {t('billing.newInvoice')}</Button>
        </CardHeader>
        <CardContent><InvoicesTable organizationId={orgId} onOpen={(inv) => setOpen(inv.id)} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('billing.paymentsTitle')}</CardTitle></CardHeader>
        <CardContent><PaymentsTable organizationId={orgId} /></CardContent>
      </Card>
      {creating ? <CreateInvoiceDialog orgId={orgId} open onOpenChange={(o) => !o && setCreating(false)} onCreated={(inv) => setOpen(inv.id)} /> : null}
      {open ? <InvoiceDialog id={open} open onOpenChange={(o) => !o && setOpen(null)} /> : null}
    </div>
  );
}
