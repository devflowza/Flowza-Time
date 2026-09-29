import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Blocks, Info, MoreHorizontal, RotateCcw, ToggleLeft, ToggleRight } from 'lucide-react';
import type { PlatformModuleDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, ErrorState, Skeleton, Switch } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useBillingMutations, usePlatformModules } from '../billing-api';
import { ReasonDialog } from '../components/reason-dialog';

type Pending = { module: PlatformModuleDto; kind: 'available' | 'enable' | 'disable' | 'reset'; value?: boolean };

/**
 * Modules (Flowza Finance /adm → Modules parity): every switchable module with its adoption across tenants, the fleet-wide
 * switch (off ⇒ off for every tenant, whatever the plan) and one-click "apply to every tenant". Per-tenant switches live on the
 * tenant's Modules tab. The core of the product (employees, attendance, shifts, reports, approvals) is never switchable.
 */
export default function AdmModulesPage() {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const q = usePlatformModules();
  const { updateModule, applyModuleToAll } = useBillingMutations();
  const [pending, setPending] = useState<Pending | null>(null);
  const run = (reason: string) => {
    if (!pending) return;
    const { module: m, kind } = pending;
    const done = () => setPending(null);
    if (kind === 'available') {
      updateModule.mutate({ key: m.key, input: { isAvailable: pending.value ?? true, reason } }, { onSuccess: () => { toast.success(t('modules.saved')); done(); }, onError: toastError });
    } else {
      applyModuleToAll.mutate({ key: m.key, input: { action: kind, reason } }, { onSuccess: (r) => { toast.success(t('modules.appliedAll', { count: r.organizations })); done(); }, onError: toastError });
    }
  };
  const name = (m: PlatformModuleDto) => tc(`modules.${m.key}.name`, { defaultValue: m.name });
  return (
    <div className="page-container">
      <PageHeader title={t('modules.title')} description={t('modules.subtitle')} />
      <Card className="mb-4 border-sky-200 bg-sky-50/60 dark:border-sky-900 dark:bg-sky-950/30">
        <CardContent className="flex gap-3 py-4 text-sm"><Info className="mt-0.5 size-4 shrink-0 text-sky-600" aria-hidden /><div className="space-y-1"><p>{t('modules.rule')}</p><p className="text-muted-foreground">{t('modules.core')}</p></div></CardContent>
      </Card>
      {q.isLoading ? <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          : (
            <div className="grid gap-3 lg:grid-cols-2">
              {(q.data ?? []).map((m) => (
                <Card key={m.key} className={m.isAvailable ? undefined : 'opacity-75'} data-testid={`module-${m.key}`}>
                  <CardContent className="space-y-3 py-4">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Blocks className="size-4" aria-hidden /></span>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 font-medium">{name(m)}<Badge variant="outline" className="font-normal">{t(`modules.categories.${m.category}`)}</Badge>{!m.isAvailable ? <Badge variant="danger">{t('modules.offFleet')}</Badge> : null}</p>
                        <p className="text-sm text-muted-foreground">{tc(`modules.${m.key}.description`, { defaultValue: m.description })}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={m.isAvailable} onCheckedChange={(v) => setPending({ module: m, kind: 'available', value: v })} aria-label={t('modules.availableToggle', { name: name(m) })} />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={t('modules.more', { name: name(m) })}><MoreHorizontal /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setPending({ module: m, kind: 'enable' })}><ToggleRight className="size-4" /> {t('modules.enableAll')}</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setPending({ module: m, kind: 'disable' })}><ToggleLeft className="size-4" /> {t('modules.disableAll')}</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setPending({ module: m, kind: 'reset' })}><RotateCcw className="size-4" /> {t('modules.resetAll')}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                      <span><span className="font-semibold text-foreground tnum">{fmtNumber(m.enabledCount)}</span> / <span className="tnum">{fmtNumber(m.totalOrganizations)}</span> {t('modules.tenantsOn')}</span>
                      {m.overrideOnCount > 0 ? <span>{t('modules.overridesOn', { count: m.overrideOnCount })}</span> : null}
                      {m.overrideOffCount > 0 ? <span>{t('modules.overridesOff', { count: m.overrideOffCount })}</span> : null}
                      <span className="flex flex-wrap items-center gap-1">{t('modules.inPlans')}{m.planKeys.length ? m.planKeys.map((k) => <Badge key={k} variant="secondary" className="font-mono text-[11px] font-normal" dir="ltr">{k}</Badge>) : <span>—</span>}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
      {pending ? (
        <ReasonDialog open onOpenChange={(o) => !o && setPending(null)} loading={updateModule.isPending || applyModuleToAll.isPending}
          destructive={pending.kind === 'disable' || (pending.kind === 'available' && pending.value === false)}
          title={t(`modules.confirm.${pending.kind === 'available' ? (pending.value ? 'makeAvailable' : 'makeUnavailable') : pending.kind}.title`, { name: name(pending.module) })}
          description={t(`modules.confirm.${pending.kind === 'available' ? (pending.value ? 'makeAvailable' : 'makeUnavailable') : pending.kind}.body`, { name: name(pending.module), count: pending.module.totalOrganizations })}
          confirmLabel={tc('common.confirm')} onConfirm={run} />
      ) : null}
    </div>
  );
}
