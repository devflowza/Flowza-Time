import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Mail, Share2 } from 'lucide-react';
import { REPORT_DELIVERY_CHANNELS, type ReportDeliveryChannel, type ReportFormat, type ReportParameters, type ReportType } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Label, Textarea } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import '../schedules-i18n';
import { useScheduleMutations } from '../schedules-api';
import { RecipientsPicker, type RecipientsValue } from './recipients-picker';

const CHANNEL_ICON: Record<ReportDeliveryChannel, typeof Bell> = { in_app: Bell, email: Mail };

/** In-app and / or email; at least one. */
export function ChannelsField({ value, onChange, error }: { value: ReportDeliveryChannel[]; onChange: (v: ReportDeliveryChannel[]) => void; error?: string }) {
  const { t } = useTranslation('reportSchedules');
  return (
    <FormField label={t('channels.label')} htmlFor="channel-in_app" required error={error}>
      <div className="flex flex-wrap gap-4">
        {REPORT_DELIVERY_CHANNELS.map((c) => {
          const Icon = CHANNEL_ICON[c];
          return (
            <Label key={c} className="flex items-center gap-2 text-sm font-normal">
              <Checkbox id={`channel-${c}`} checked={value.includes(c)} onCheckedChange={(on) => onChange(on === true ? [...new Set([...value, c])] : value.filter((x) => x !== c))} />
              <Icon className="size-3.5 text-muted-foreground" /> {t(`channels.${c}`)}
            </Label>
          );
        })}
      </div>
    </FormField>
  );
}

export interface ShareSpec { reportType: ReportType; format: ReportFormat; parameters: ReportParameters; title: string }

/**
 * "Send now" (HR portal Prompt 6a): the report the sender just configured is generated ONCE PER RECIPIENT, in the background,
 * under each recipient's own access scope (a manager receives their team, a branch manager their branches); anyone who could
 * not request the report themselves is skipped with a reason in the delivery log. Recipients get an in-app notification and / or
 * an email that opens the report inside the application — no file or link that works outside it is mailed.
 */
export function ShareReportDialog({ spec, onClose }: { spec: ShareSpec; onClose: () => void }) {
  const { t } = useTranslation('reportSchedules');
  const { t: tc } = useTranslation();
  const { share } = useScheduleMutations();
  const [recipients, setRecipients] = useState<RecipientsValue>({ userIds: [], roleKeys: [] });
  const [channels, setChannels] = useState<ReportDeliveryChannel[]>(['in_app', 'email']);
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const noRecipients = recipients.userIds.length + recipients.roleKeys.length === 0;
  const noChannel = channels.length === 0;
  const submit = () => {
    setTouched(true);
    if (noRecipients || noChannel) return;
    share.mutate({ reportType: spec.reportType, format: spec.format, parameters: spec.parameters, recipients, channels, note: note.trim() || undefined }, {
      onSuccess: (res) => { toast.success(t('share.queued', { count: res.recipients }), { description: t('share.queuedHint') }); onClose(); },
      onError: toastError,
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Share2 className="size-4" /> {t('share.title')}</DialogTitle>
          <DialogDescription>{t('share.subtitle', { report: spec.title })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField label={t('recipients.label')} htmlFor="share-recipients" required error={touched && noRecipients ? t('recipients.required') : undefined}>
            <RecipientsPicker id="share-recipients" value={recipients} onChange={setRecipients} invalid={touched && noRecipients} />
          </FormField>
          <ChannelsField value={channels} onChange={setChannels} error={touched && noChannel ? t('channels.required') : undefined} />
          <FormField label={t('share.note')} htmlFor="share-note" optional>
            <Textarea id="share-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('share.notePlaceholder')} />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={submit} loading={share.isPending}><Share2 /> {t('share.send')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
