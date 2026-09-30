import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import type { OrgModuleStateDto } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Skeleton, Switch } from '@/components/ui';
import { fmtRelative } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useBillingMutations, useOrgModules } from '../billing-api';
import { ReasonDialog } from './reason-dialog';

/**
 * Tenant → Modules (Flowza Finance tenant ModulesTab parity): each switchable module with what the plan says, the platform's
 * override and the result. Switching one on or off records an override with a reason (audited on the tenant); "Back to plan"
 * removes it. Off = hidden and closed for the tenant (navigation, pages and API); its data is kept.
 */
export function TenantModulesPanel({ orgId }: { orgId: string }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const q = useOrgModules(orgId);
  const { putOrgModules } = useBillingMutations();
  const [pending, setPending] = useState<{ module: OrgModuleStateDto; value: boolean | null } | null>(null);
  const name = (m: OrgModuleStateDto) => tc(`modules.${m.key}.name`, { defaultValue: m.name });
  const apply = (reason: string) => {
    if (!pending) return;
    putOrgModules.mutate({ id: orgId, input: { modules: { [pending.module.key]: pending.value }, reason } }, {
      onSuccess: () => { toast.success(t('tenantModules.saved')); setPending(null); }, onError: toastError,
    });
  };
  const lapsed = q.data?.some((m) => m.lapsed) ?? false;
  return (
    <Card>
      <CardHeader><CardTitle>{t('tenantModules.title')}</CardTitle><CardDescription>{t('tenantModules.hint')}</CardDescription></CardHeader>
      <CardContent>
        {lapsed ? <p role="status" className="mb-3 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('tenantModules.lapsed')}</p> : null}
        {q.isLoading ? <Skeleton className="h-64 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <ul className="divide-y">
            {(q.data ?? []).map((m) => (
              <li key={m.key} className="flex flex-wrap items-center gap-3 py-3" data-testid={`tenant-module-${m.key}`}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {name(m)}
                    <Badge variant={m.enabled ? 'success' : 'neutral'}>{m.enabled ? t('tenantModules.on') : t('tenantModules.off')}</Badge>
                    {m.inPlan ? <Badge variant="outline" className="font-normal">{t('tenantModules.inPlan')}</Badge> : <Badge variant="outline" className="font-normal">{t('tenantModules.notInPlan')}</Badge>}
                    {m.override !== null ? <Badge variant="info" className="font-normal">{m.override ? t('tenantModules.forcedOn') : t('tenantModules.forcedOff')}</Badge> : null}
                    {!m.available ? <Badge variant="danger" className="font-normal">{t('modules.offFleet')}</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{tc(`modules.${m.key}.description`, { defaultValue: m.description })}</p>
                  {m.override !== null && m.reason ? <p className="mt-1 text-xs text-muted-foreground">{t('tenantModules.why', { reason: m.reason })}{m.updatedAt ? ` · ${fmtRelative(m.updatedAt)}` : ''}</p> : null}
                </div>
                {m.override !== null ? <Button size="sm" variant="ghost" onClick={() => setPending({ module: m, value: null })}><RotateCcw /> {t('tenantModules.backToPlan')}</Button> : null}
                <Switch checked={m.enabled} disabled={!m.available || m.lapsed} onCheckedChange={(v) => setPending({ module: m, value: v })} aria-label={t('tenantModules.toggle', { name: name(m) })} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {pending ? (
        <ReasonDialog open onOpenChange={(o) => !o && setPending(null)} loading={putOrgModules.isPending} destructive={pending.value === false}
          title={pending.value === null ? t('tenantModules.resetTitle', { name: name(pending.module) }) : pending.value ? t('tenantModules.enableTitle', { name: name(pending.module) }) : t('tenantModules.disableTitle', { name: name(pending.module) })}
          description={pending.value === false ? t('tenantModules.disableBody') : pending.value === null ? t('tenantModules.resetBody', { state: pending.module.inPlan ? t('tenantModules.on') : t('tenantModules.off') }) : t('tenantModules.enableBody')}
          confirmLabel={tc('common.confirm')} onConfirm={apply} />
      ) : null}
    </Card>
  );
}
