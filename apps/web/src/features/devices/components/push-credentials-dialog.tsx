import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label } from '@/components/ui';

export interface PushCredentials { pushToken: string | null; pushUrl: string | null; webhookUrl: string | null }

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable: the value is selectable */ }
  };
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-stretch gap-2">
        <code id={id} dir="ltr" className="flex-1 select-all overflow-x-auto whitespace-nowrap rounded-md border bg-muted px-3 py-2 font-mono text-xs scrollbar-thin">{value}</code>
        <Button type="button" variant="outline" size="icon" onClick={() => void copy()} aria-label={copied ? t('common.copied') : t('common.copy')}>{copied ? <Check className="text-emerald-600" /> : <Copy />}</Button>
      </div>
    </div>
  );
}

/** One-time display of the push token / URLs returned by registration, claim or rotation — never retrievable again. */
export function PushCredentialsDialog({ credentials, onClose, title }: { credentials: PushCredentials | null; onClose: () => void; title?: string }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  if (!credentials) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><KeyRound className="size-5 text-brand-700" /> {title ?? t('push.title')}</DialogTitle>
          <DialogDescription>{t('push.onceHint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {credentials.pushToken ? <CopyField id="push-token" label={t('push.token')} value={credentials.pushToken} /> : null}
          {credentials.pushUrl ? <CopyField id="push-url" label={t('push.url')} value={credentials.pushUrl} /> : null}
          {credentials.webhookUrl ? <CopyField id="webhook-url" label={t('push.webhookUrl')} value={credentials.webhookUrl} /> : null}
          <div className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('push.instructions')}</div>
        </div>
        <DialogFooter><Button type="button" onClick={onClose}>{tc('common.close')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
