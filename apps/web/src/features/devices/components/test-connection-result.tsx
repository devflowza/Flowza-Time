import { CheckCircle2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TestConnectionResultDto } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

function KeyValues({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {entries.map(([k, v]) => <div key={k} className="contents"><dt className="font-mono text-muted-foreground">{k}</dt><dd className="truncate" dir="ltr">{String(v)}</dd></div>)}
    </dl>
  );
}

/** Outcome of POST /devices/test-connection: never contains secrets; shows latency, provider error code and device info. */
export function TestConnectionResult({ result }: { result: TestConnectionResultDto }) {
  const { t } = useTranslation('devices');
  return (
    <div role="status" className={cn('space-y-3 rounded-lg border p-4', result.ok ? 'border-emerald-300/60 bg-emerald-50/60 dark:bg-emerald-950/30' : 'border-red-300/60 bg-red-50/60 dark:bg-red-950/30')}>
      <div className="flex items-start gap-3">
        {result.ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden /> : <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{result.ok ? t('test.ok') : t('test.failed')}</p>
          <p className="text-sm text-muted-foreground">{result.message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="tnum">{t('test.latency', { ms: fmtNumber(result.latencyMs) })}</Badge>
            {result.code ? <Badge variant="danger" className="font-mono">{result.code}</Badge> : null}
            {!result.ok && result.retryable ? <Badge variant="warning">{t('test.retryable')}</Badge> : null}
            {result.usedStoredCredentials ? <Badge variant="secondary">{t('test.usedStored')}</Badge> : null}
          </div>
        </div>
      </div>
      {result.deviceInfo ? <div><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('test.deviceInfo')}</p><KeyValues data={result.deviceInfo} /></div> : null}
      {result.details ? <div><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('test.details')}</p><KeyValues data={result.details} /></div> : null}
    </div>
  );
}
