import { useTranslation } from 'react-i18next';
import type { EmailEventDto } from '@flowza/contracts';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, ErrorState, Skeleton } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmailMessage } from '../email-log-api';
import { CopyButton } from './copy-button';
import { neverLeftServer, useReasonText } from '../email-status-utils';
import { EmailStatusBadge } from './email-status';

const EVENT_TONE: Partial<Record<EmailEventDto['event'], string>> = {
  delivered: 'bg-emerald-500', opened: 'bg-emerald-500', clicked: 'bg-emerald-500', sent: 'bg-blue-500',
  attempt_failed: 'bg-amber-500', delayed: 'bg-amber-500',
  failed: 'bg-red-500', bounced: 'bg-red-500', complained: 'bg-red-500', provider_failed: 'bg-red-500', suppressed: 'bg-red-500',
};

/** One e-mail of the log: where it stands, the provider's message id, and its timeline (worker attempts, provider events). */
export function EmailDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation('email-log');
  const tz = useOrgTimezone();
  const q = useEmailMessage(id);
  const reason = useReasonText();
  const m = q.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2"><span className="truncate" dir="auto">{m?.subject ?? (m ? t(`kinds.${m.kind}`) : t('detail.title'))}</span>{m ? <EmailStatusBadge message={m} /> : null}</DialogTitle>
          <DialogDescription dir="ltr" className="text-start">{m ? m.recipient : ' '}</DialogDescription>
        </DialogHeader>
        {q.isLoading ? <div className="space-y-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-24 w-full" /></div> : null}
        {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
        {m ? (
          <div className="space-y-4" data-testid="email-detail">
            {neverLeftServer(m) ? <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">{t('banner.console', { count: 1 })}</p> : null}
            {m.lastError && ['failed', 'bounced', 'complained', 'retrying', 'delayed', 'skipped'].includes(m.status) ? (
              <p className={cn('rounded-md border p-2 text-xs', m.status === 'skipped' ? 'bg-muted/40 text-muted-foreground' : 'border-red-200 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100')} dir="auto">{reason(m.lastError)}</p>
            ) : null}
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Field label={t('columns.type')} value={m.kind === 'invitation' ? t('kinds.invitation') : m.category} mono={m.kind !== 'invitation'} />
              <Field label={t('columns.recipient')} value={m.recipientName ? `${m.recipientName} · ${m.recipient}` : m.recipient} />
              <Field label={t('detail.queuedAt')} value={fmtDateTime(m.createdAt, tz, 'dd MMM yyyy, HH:mm:ss')} />
              <Field label={t('detail.sentAt')} value={m.sentAt ? fmtDateTime(m.sentAt, tz, 'dd MMM yyyy, HH:mm:ss') : null} />
              <Field label={t('detail.provider')} value={m.provider} />
              <Field label={t('detail.messageId')} value={m.providerMessageId} mono copy />
              <Field label={t('columns.attempts')} value={String(m.attempts)} />
              <Field label={t('detail.nextAttempt')} value={m.status === 'retrying' && m.nextAttemptAt ? fmtDateTime(m.nextAttemptAt, tz, 'dd MMM yyyy, HH:mm:ss') : null} />
            </dl>
            <section>
              <h3 className="mb-2 text-sm font-medium">{t('detail.timeline')}</h3>
              <ol className="space-y-3 border-s ps-4" data-testid="email-timeline">
                {m.events.map((e) => (
                  <li key={e.id} className="relative">
                    <span className={cn('absolute -start-[21px] top-1.5 size-2.5 rounded-full ring-2 ring-background', EVENT_TONE[e.event] ?? 'bg-slate-400')} aria-hidden />
                    <p className="text-sm font-medium">{t(`events.${e.event}`, { attempt: e.attempt ?? '', provider: e.event === 'sent' ? (e.detail ?? '') : '' })}</p>
                    <p className="tnum text-xs text-muted-foreground">{fmtDateTime(e.occurredAt, tz, 'dd MMM yyyy, HH:mm:ss')}</p>
                    {e.detail && e.event !== 'sent' ? <p className="text-xs text-muted-foreground" dir="auto">{reason(e.detail)}</p> : null}
                  </li>
                ))}
              </ol>
              {!m.events.some((e) => ['delivered', 'bounced', 'complained', 'delayed', 'provider_failed', 'suppressed'].includes(e.event)) && m.status === 'sent' && !neverLeftServer(m)
                ? <p className="mt-3 text-xs text-muted-foreground">{t('detail.awaitingProvider')}</p> : null}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, mono, copy }: { label: string; value: string | null | undefined; mono?: boolean; copy?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('flex min-w-0 items-center gap-1 truncate', mono && 'font-mono text-xs')} dir={mono ? 'ltr' : 'auto'}>
        <span className="truncate" title={value ?? undefined}>{value || '—'}</span>
        {copy && value ? <CopyButton value={value} size="sm" className="size-6" /> : null}
      </dd>
    </div>
  );
}
