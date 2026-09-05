import { useTranslation } from 'react-i18next';
import type { AuditLogDto } from '@flowza/contracts';
import { Badge, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { JsonDiffView } from './json-diff-view';
import { CopyButton } from './copy-button';

export function AuditDetailDialog({ entry, onClose }: { entry: AuditLogDto | null; onClose: () => void }) {
  const { t } = useTranslation('audit');
  const tz = useOrgTimezone();
  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        {entry ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2"><span className="font-mono text-base" dir="ltr">{entry.action}</span><Badge variant="secondary">{entry.entityType}</Badge></DialogTitle>
              <DialogDescription className="tnum">{fmtDateTime(entry.createdAt, tz, 'dd MMM yyyy, HH:mm:ss')} · {entry.actorName ?? entry.actorLabel ?? t('system')} ({entry.actorType})</DialogDescription>
            </DialogHeader>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t('columns.entityId')} value={entry.entityId} mono copy />
              <Field label={t('columns.requestId')} value={entry.requestId} mono copy />
              <Field label={t('detail.jobId')} value={entry.jobId} mono copy />
              <Field label={t('detail.ip')} value={entry.ip} mono />
              <Field label={t('detail.branch')} value={entry.branchId} mono />
              <Field label={t('detail.reason')} value={entry.reason} />
            </dl>
            <JsonDiffView oldValue={entry.oldValue} newValue={entry.newValue} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, mono, copy }: { label: string; value: string | null | undefined; mono?: boolean; copy?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1"><span className={mono ? 'truncate font-mono text-xs' : 'truncate'} dir={mono ? 'ltr' : undefined} title={value ?? undefined}>{value ?? '—'}</span>{copy && value ? <CopyButton value={value} size="sm" className="size-6" /> : null}</dd>
    </div>
  );
}
