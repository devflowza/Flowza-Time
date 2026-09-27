import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Link2, RefreshCw, UserX, XCircle } from 'lucide-react';
import type { z } from 'zod';
import { FINANCE_PIN_KEYS, FINANCE_POLL_MINUTES, FINANCE_SYNC_DIRECTIONS, financeIntegrationInputSchema, type FinanceIntegrationDto, type FinanceIntegrationStatusDto, type FinanceIntegrationTestDto } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StatCard, Switch } from '@/components/ui';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { toNumber } from '@/features/organization/form-utils';
import { useFinanceIntegration, useFinanceIntegrationMutations, useFinanceStatus } from '../integrations-api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';

type Values = z.input<typeof financeIntegrationInputSchema>;
type Output = z.output<typeof financeIntegrationInputSchema>;

export default function IntegrationsSection() {
  const { t } = useTranslation('settings');
  const canManage = useCan()('integration.manage');
  const q = useFinanceIntegration(canManage);
  if (!canManage) return <Card><CardContent className="pt-5 text-sm text-muted-foreground">{t('integrations.noPermission')}</CardContent></Card>;
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      <FinanceForm key={q.data.updatedAt ?? 'new'} initial={q.data} />
      <FinanceStatusCard integration={q.data} />
    </>
  );
}

/** The branch is not edited here: the server keeps the connector's branch (or picks the first active one on creation). */
function toValues(d: FinanceIntegrationDto): Values {
  return { enabled: d.configured ? d.enabled : true, baseUrl: d.baseUrl, deviceSerial: d.deviceSerial ?? '', direction: d.direction, pinKey: d.pinKey, pollMinutes: d.pollMinutes };
}

export function FinanceForm({ initial }: { initial: FinanceIntegrationDto }) {
  const { t } = useTranslation('settings');
  const { save, test } = useFinanceIntegrationMutations();
  const [replacingToken, setReplacingToken] = useState(!initial.hasToken);
  const [testResult, setTestResult] = useState<FinanceIntegrationTestDto | null>(null);
  const form = useForm<Values, unknown, Output>({ resolver: zodResolver(financeIntegrationInputSchema), defaultValues: toValues(initial) });
  const { register, control, formState: { errors, isSubmitting, isDirty }, getValues, setValue } = form;
  const tokenVisible = replacingToken;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload: Output = { ...values };
      if (!tokenVisible || !payload.token) delete payload.token; // an omitted token keeps the stored one
      const saved = await save.mutateAsync(payload);
      toast.success(t('saved'));
      form.reset(toValues(saved));
      setReplacingToken(!saved.hasToken);
      setTestResult(null);
    } catch (e) { toastError(e); }
  });

  const onTest = async () => {
    const v = getValues();
    const body = { baseUrl: v.baseUrl || undefined, deviceSerial: v.deviceSerial || undefined, ...(tokenVisible && v.token ? { token: v.token } : {}) };
    try { setTestResult(await test.mutateAsync(body)); } catch (e) { toastError(e); }
  };

  const testButton = <Button type="button" variant="outline" onClick={() => void onTest()} loading={test.isPending}>{t('integrations.test')}</Button>;

  return (
    <SettingsSection title={t('integrations.title')} description={t('integrations.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty || (tokenVisible && !!getValues('token'))} footer={testButton}>
      <Controller control={control} name="enabled" render={({ field }) => <SwitchRow id="fin-enabled" label={t('integrations.enabled')} hint={t('integrations.enabledHint')} control={<Switch id="fin-enabled" checked={!!field.value} onCheckedChange={field.onChange} />} />} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('integrations.baseUrl')} htmlFor="fin-base-url" hint={t('integrations.baseUrlHint')} error={errors.baseUrl?.message} className="sm:col-span-2">
          <Input id="fin-base-url" dir="ltr" placeholder="https://<project>.supabase.co/functions/v1" {...register('baseUrl')} aria-invalid={!!errors.baseUrl} />
        </FormField>
        <FormField label={t('integrations.deviceSerial')} htmlFor="fin-serial" hint={t('integrations.deviceSerialHint')} error={errors.deviceSerial?.message} required>
          <Input id="fin-serial" dir="ltr" className="font-mono" placeholder="FLOWZA-TIME-ACME" {...register('deviceSerial')} aria-invalid={!!errors.deviceSerial} />
        </FormField>
        <FormField label={t('integrations.token')} htmlFor="fin-token" hint={t('integrations.tokenHint')} error={errors.token?.message} required={!initial.hasToken}>
          {tokenVisible ? (
            <div className="flex items-center gap-2">
              <Input id="fin-token" type="password" dir="ltr" autoComplete="new-password" className="font-mono" {...register('token')} aria-invalid={!!errors.token} />
              {initial.hasToken ? <Button type="button" variant="ghost" size="sm" onClick={() => { setValue('token', undefined, { shouldDirty: false }); setReplacingToken(false); }}>{t('integrations.keepToken')}</Button> : null}
            </div>
          ) : (
            <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-input bg-muted/40 px-3 text-sm">
              <span className="font-mono text-muted-foreground" dir="ltr">{t('integrations.tokenStored', { masked: initial.tokenMasked ?? '••••' })}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setReplacingToken(true)}>{t('integrations.replaceToken')}</Button>
            </div>
          )}
        </FormField>
        <FormField label={t('integrations.direction')} htmlFor="fin-direction" hint={t('integrations.directionHint')} error={errors.direction?.message}>
          <Controller control={control} name="direction" render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="fin-direction" aria-label={t('integrations.direction')}><SelectValue /></SelectTrigger>
              <SelectContent>{FINANCE_SYNC_DIRECTIONS.map((d) => <SelectItem key={d} value={d}>{t(`integrations.directions.${d}`)}</SelectItem>)}</SelectContent>
            </Select>
          )} />
        </FormField>
        <FormField label={t('integrations.pinKey')} htmlFor="fin-pin-key" hint={t('integrations.pinKeyHint')} error={errors.pinKey?.message}>
          <Controller control={control} name="pinKey" render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="fin-pin-key" aria-label={t('integrations.pinKey')}><SelectValue /></SelectTrigger>
              <SelectContent>{FINANCE_PIN_KEYS.map((k) => <SelectItem key={k} value={k}>{t(`integrations.pinKeys.${k}`)}</SelectItem>)}</SelectContent>
            </Select>
          )} />
        </FormField>
        <FormField label={t('integrations.pollMinutes')} htmlFor="fin-poll" hint={t('integrations.pollMinutesHint', { min: FINANCE_POLL_MINUTES.min, max: FINANCE_POLL_MINUTES.max })} error={errors.pollMinutes?.message}>
          <Input id="fin-poll" type="number" min={FINANCE_POLL_MINUTES.min} max={FINANCE_POLL_MINUTES.max} dir="ltr" className="tnum" {...register('pollMinutes', { setValueAs: toNumber })} aria-invalid={!!errors.pollMinutes} />
        </FormField>
      </div>
      {testResult ? <FinanceTestResult result={testResult} /> : null}
    </SettingsSection>
  );
}

export function FinanceTestResult({ result }: { result: FinanceIntegrationTestDto }) {
  const { t } = useTranslation('settings');
  const tz = useOrgTimezone();
  return (
    <div role="status" className={cn('space-y-2 rounded-lg border p-4', result.ok ? 'border-emerald-300/60 bg-emerald-50/60 dark:bg-emerald-950/30' : 'border-red-300/60 bg-red-50/60 dark:bg-red-950/30')}>
      <div className="flex items-start gap-3">
        {result.ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden /> : <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{result.ok ? t('integrations.testOk') : t('integrations.testFailed')}</p>
          <p className="text-sm text-muted-foreground">{result.message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="tnum">{t('integrations.latency', { ms: fmtNumber(result.latencyMs) })}</Badge>
            {result.code ? <Badge variant="danger" className="font-mono">{result.code}</Badge> : null}
            {result.usedStoredCredentials ? <Badge variant="secondary">{t('integrations.usedStored')}</Badge> : null}
            {result.serverTime ? <Badge variant="outline">{t('integrations.serverTime', { time: fmtDateTime(result.serverTime, tz) })}</Badge> : null}
            {result.ok ? <Badge variant="outline">{result.firstPunchAt ? t('integrations.firstPunch', { time: fmtDateTime(result.firstPunchAt, tz) }) : t('integrations.noPunches')}</Badge> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

const JOB_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = { SUCCESS: 'success', PARTIAL_SUCCESS: 'warning', FAILED: 'danger', RUNNING: 'info', RETRYING: 'warning', QUEUED: 'info', PENDING: 'neutral', CANCELLED: 'neutral' };

export function FinanceStatusCard({ integration }: { integration: FinanceIntegrationDto }) {
  const { t } = useTranslation('settings');
  const { t: ts } = useTranslation('sync');
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const { syncNow } = useFinanceIntegrationMutations();
  const q = useFinanceStatus(integration.configured);
  if (!integration.configured) return null;
  const s: FinanceIntegrationStatusDto | undefined = q.data;
  const state = s?.state ?? null;
  const onSyncNow = () => syncNow.mutate(undefined, { onSuccess: (r) => { toast.success(t('integrations.syncQueued'), { description: r.message, action: r.pullJobId || r.pushJobId ? { label: ts('jobs.view'), onClick: () => navigate(`/sync/${r.pullJobId ?? r.pushJobId}`) } : undefined }); }, onError: toastError });
  const when = (iso: string | null | undefined) => (iso ? fmtRelative(iso) : t('integrations.never'));
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div><CardTitle>{t('integrations.statusTitle')}</CardTitle><CardDescription>{t('integrations.statusHint')}</CardDescription></div>
        <div className="flex items-center gap-2">
          {s?.connectionStatus ? <Badge variant={s.connectionStatus === 'online' ? 'success' : s.connectionStatus === 'error' || s.connectionStatus === 'offline' ? 'danger' : 'neutral'} dot>{s.connectionStatus}</Badge> : null}
          {!integration.enabled ? <Badge variant="warning">{t('integrations.disabled')}</Badge> : null}
          <Button type="button" size="sm" onClick={onSyncNow} loading={syncNow.isPending} disabled={!integration.enabled}><RefreshCw /> {t('integrations.syncNow')}</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('integrations.lastPull')} value={when(state?.lastPullAt)} hint={state ? t('integrations.punches', { count: state.lastPullCount }) : undefined} icon={ArrowDownToLine} tone="info" loading={q.isLoading} />
          <StatCard label={t('integrations.lastPush')} value={when(state?.lastPushAt)} hint={state ? t('integrations.punches', { count: state.lastPushCount }) : undefined} icon={ArrowUpFromLine} tone="info" loading={q.isLoading} />
          <StatCard label={t('integrations.failures')} value={state?.consecutiveFailures ?? 0} hint={state?.lastError ?? undefined} icon={AlertTriangle} tone={(state?.consecutiveFailures ?? 0) > 0 ? 'danger' : 'success'} loading={q.isLoading} />
          <StatCard label={t('integrations.unmatched')} value={s?.unmatchedCount ?? 0} hint={t('integrations.unmatchedHint')} icon={UserX} tone={(s?.unmatchedCount ?? 0) > 0 ? 'warning' : 'default'} loading={q.isLoading}
            onClick={s?.deviceId ? () => navigate(`/attendance?tab=raw&processingStatus=unmatched&deviceId=${s.deviceId}`) : undefined} />
        </div>
        {state?.lastError ? <p className="text-xs text-red-700 dark:text-red-300" dir="ltr">{state.lastError}</p> : null}
        {s?.circuit && s.circuit.state !== 'closed' ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('integrations.circuit', { state: s.circuit.state, at: s.circuit.halfOpenAt ? fmtDateTime(s.circuit.halfOpenAt, tz) : '—' })}</p> : null}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('integrations.recentJobs')}</p>
          {s && s.lastJobs.length === 0 ? <p className="text-sm text-muted-foreground">{t('integrations.noJobs')}</p> : null}
          <ul className="divide-y rounded-md border">
            {(s?.lastJobs ?? []).map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant={JOB_TONE[j.status] ?? 'neutral'}>{j.status}</Badge>
                  <span>{ts(`jobType.${j.jobType}`, { defaultValue: j.jobType })}</span>
                  <span className="text-xs text-muted-foreground">{fmtDateTime(j.createdAt, tz)}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="tnum">{t('integrations.punches', { count: j.recordsIngested })}</span>
                  {j.errorCode ? <span className="font-mono text-red-700 dark:text-red-300">{j.errorCode}</span> : null}
                  <Button type="button" variant="ghost" size="sm" onClick={() => navigate(`/sync/${j.id}`)}><Link2 /> {t('integrations.viewJob')}</Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
