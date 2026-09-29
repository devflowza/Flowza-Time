import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { RawStatusBadge } from '@/features/attendance/components/badges';
import type { RawTransactionDto } from '@/features/attendance/types';

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);

function Field({ label, children, mono = false, wide = false }: { label: string; children: React.ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={wide ? 'min-w-0 sm:col-span-3' : 'min-w-0'}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? 'mt-0.5 break-all font-mono text-sm' : 'mt-0.5 break-words text-sm'} dir={mono ? 'ltr' : undefined}>{children ?? '—'}</dd>
    </div>
  );
}

/**
 * Raw punch (Devices & punches → Punch log): every stored fact of one raw device transaction — local and UTC time, device
 * serial and zone, PIN, employee, verify mode, punch state, dedupe hash — and the device payload exactly as stored (providers
 * keep an allowlist of fields; templates and photos never reach it). Copy JSON copies the whole record.
 */
export function RawPunchDialog({ punch, tz, onClose }: { punch: RawTransactionDto; tz: string; onClose: () => void }) {
  const { t } = useTranslation('devices');
  const { t: ta } = useTranslation('attendance');
  const [copied, setCopied] = useState(false);
  const zone = punch.deviceTimezone ?? punch.assumedTimezone ?? tz;
  const payload = punch.rawPayload ?? {};
  const lat = num(pick(payload, 'lat', 'latitude'));
  const lng = num(pick(payload, 'lng', 'lon', 'longitude'));
  const workCode = text(pick(payload, 'workCode', 'work_code', 'workcode'));
  const geoVerdict = text(pick(payload, 'geofenceVerdict', 'geofence_verdict', 'verdict'));
  const dash = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(punch, null, 2));
      setCopied(true);
      toast.success(t('punchLog.raw.copied'));
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('punchLog.raw.copyFailed'));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="lg" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0 pe-8">
          <DialogTitle>{t('punchLog.raw.title')}</DialogTitle>
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>{copied ? <Check /> : <Copy />} {t('punchLog.raw.copy')}</Button>
        </DialogHeader>
        <DialogDescription className="sr-only">{t('punchLog.raw.description')}</DialogDescription>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          <Field label={t('punchLog.raw.localTime')}>{fmtDateTime(punch.punchedAt, zone, 'dd MMM yyyy, HH:mm:ss')}</Field>
          <Field label={t('punchLog.raw.utcTime')} mono>{punch.punchedAt}</Field>
          <Field label={t('punchLog.raw.deviceTimezone')}>{zone}</Field>
          <Field label={t('punchLog.raw.deviceSerial')} mono>{dash(punch.deviceSerial ?? punch.deviceCode)}</Field>
          <Field label={t('punchLog.raw.pin')} mono>{dash(punch.deviceEmployeeId)}</Field>
          <Field label={t('punchLog.raw.employee')}>{punch.employeeName ? `${punch.employeeName}${punch.employeeNumber ? ` (${punch.employeeNumber})` : ''}` : <span className="text-destructive">{t('punchLog.unmapped')}</span>}</Field>
          <Field label={t('punchLog.raw.source')}>{t(`punchLog.source.${punch.source}`, { defaultValue: punch.source })}</Field>
          <Field label={t('punchLog.raw.verifyMode')}>{punch.verificationMethod ? t(`punchLog.verify.${punch.verificationMethod}`, { defaultValue: punch.verificationMethod }) : '—'}</Field>
          <Field label={t('punchLog.raw.punchState')}>{punch.direction ? t(`punchLog.direction.${punch.direction}`, { defaultValue: punch.direction }) : '—'}</Field>
          <Field label={t('punchLog.raw.workCode')} mono>{dash(workCode)}</Field>
          <Field label={t('punchLog.raw.geo')} mono>{lat !== undefined && lng !== undefined ? `${lat}, ${lng}` : '—'}</Field>
          <Field label={t('punchLog.raw.geoVerdict')}>{dash(geoVerdict)}</Field>
          <Field label={t('punchLog.raw.receivedAt')} mono>{punch.receivedAt}</Field>
          <Field label={t('punchLog.raw.deviceClock')} mono>{punch.deviceLocalTime ? `${punch.deviceLocalTime}${punch.clockSkewSeconds ? ` (${ta('raw.skew', { seconds: punch.clockSkewSeconds })})` : ''}` : '—'}</Field>
          <Field label={t('punchLog.raw.status')}><span className="flex flex-col items-start gap-1"><RawStatusBadge status={punch.processingStatus} />{punch.processingError ? <span className="text-xs text-destructive">{punch.processingError}</span> : null}</span></Field>
          <Field label={t('punchLog.raw.employeeId')} mono>{dash(punch.employeeId)}</Field>
          <Field label={t('punchLog.raw.transactionId')} mono>{dash(punch.providerTransactionId)}</Field>
          <Field label={t('punchLog.raw.dedupeHash')} mono>{dash(punch.dedupeHash)}</Field>
          <Field label={t('punchLog.raw.payload')} wide>
            <pre className="mt-1 max-h-64 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed" dir="ltr">{JSON.stringify(payload, null, 2)}</pre>
          </Field>
        </dl>
      </DialogContent>
    </Dialog>
  );
}
