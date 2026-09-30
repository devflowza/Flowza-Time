import { useTranslation } from 'react-i18next';
import { AlertTriangle, Ban, CheckCheck, Clock, MailCheck, MailWarning, MailX, RotateCw, ShieldAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { EmailMessageDto, EmailStatus } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { neverLeftServer } from '../email-status-utils';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'secondary';
const STATUS: Record<EmailStatus, { tone: Tone; icon: LucideIcon }> = {
  queued: { tone: 'info', icon: Clock },
  retrying: { tone: 'warning', icon: RotateCw },
  sent: { tone: 'secondary', icon: MailCheck },
  delivered: { tone: 'success', icon: CheckCheck },
  delayed: { tone: 'warning', icon: Clock },
  bounced: { tone: 'danger', icon: MailX },
  complained: { tone: 'danger', icon: ShieldAlert },
  failed: { tone: 'danger', icon: AlertTriangle },
  skipped: { tone: 'neutral', icon: Ban },
};

/** Where an e-mail stands, as one badge (the console mailer's "sent" reads "Not delivered"). */
export function EmailStatusBadge({ message }: { message: Pick<EmailMessageDto, 'status' | 'provider'> }) {
  const { t } = useTranslation('email-log');
  if (neverLeftServer(message)) return <Badge variant="warning" data-status="not-delivered"><MailWarning className="size-3" aria-hidden /> {t('status.notDelivered')}</Badge>;
  const s = STATUS[message.status] ?? STATUS.queued;
  const Icon = s.icon;
  return <Badge variant={s.tone} data-status={message.status}><Icon className="size-3" aria-hidden /> {t(`status.${message.status}`)}</Badge>;
}
