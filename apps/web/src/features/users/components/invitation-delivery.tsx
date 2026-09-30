import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { AlertTriangle, History, Loader2, MailCheck, MailWarning, MailX, RotateCw } from 'lucide-react';
import { INVITATION_EMAIL_MAX_ATTEMPTS, type InvitationDto } from '@flowza/contracts';
import { Badge, Button } from '@/components/ui';
import { fmtRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { emailLogOfInvitation, useCanReadEmailLog } from '@/features/audit/email-log-api';
import { invitationDeliveryStatus, useInvitation, useMemberMutations } from '../api';

type Delivery = Pick<InvitationDto, 'deliveryStatus' | 'deliveryAttempts' | 'deliveryLastError' | 'deliveryNextAttemptAt' | 'deliverySentAt' | 'deliveryProvider'> & { id?: string };

/**
 * The e-mail delivery of one invitation, as the worker records it: sending, e-mailed (or "not delivered" when the server has
 * no e-mail provider configured), retrying after a failed attempt (with when the queue tries again and why it failed), or
 * failed — with a button to queue the e-mail again when `onRetry` is given, and a link to its timeline in the e-mail log
 * (delivered, bounced …) for the members who may read the log.
 */
export function InvitationDelivery({ invitation, onRetry, retrying, className }: { invitation: Delivery; onRetry?: () => void; retrying?: boolean; className?: string }) {
  const { t } = useTranslation('users');
  const canReadLog = useCanReadEmailLog();
  const status = invitationDeliveryStatus(invitation);
  const error = invitation.deliveryLastError ? <span className="block text-xs text-muted-foreground" dir="auto">{invitation.deliveryLastError}</span> : null;
  const retry = onRetry ? (
    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" loading={retrying} onClick={onRetry}>{retrying ? null : <RotateCw />} {status === 'none' ? t('delivery.send') : t('delivery.retry')}</Button>
  ) : null;

  let body: ReactNode;
  if (status === 'sent' && invitation.deliveryProvider === 'console') {
    body = <><Badge variant="warning"><MailWarning className="size-3" aria-hidden /> {t('delivery.notDelivered')}</Badge><span className="block text-xs text-muted-foreground">{t('delivery.notConfigured')}</span></>;
  } else if (status === 'sent') {
    body = <Badge variant="success"><MailCheck className="size-3" aria-hidden /> {invitation.deliverySentAt ? t('resend.emailed', { when: fmtRelative(invitation.deliverySentAt) }) : t('delivery.sent')}</Badge>;
  } else if (status === 'queued') {
    body = <Badge variant="info"><Loader2 className="size-3 animate-spin" aria-hidden /> {t('delivery.queued')}</Badge>;
  } else if (status === 'retrying') {
    body = (
      <>
        <Badge variant="warning"><RotateCw className="size-3" aria-hidden /> {t('delivery.retrying', { attempt: invitation.deliveryAttempts ?? 1, max: INVITATION_EMAIL_MAX_ATTEMPTS })}</Badge>
        {invitation.deliveryNextAttemptAt ? <span className="block text-xs text-muted-foreground">{t('delivery.nextAttempt', { when: fmtRelative(invitation.deliveryNextAttemptAt) })}</span> : null}
        {error}
      </>
    );
  } else if (status === 'failed') {
    body = <><Badge variant="danger"><MailX className="size-3" aria-hidden /> {t('delivery.failed')}</Badge>{error}</>;
  } else {
    body = <Badge variant="neutral"><AlertTriangle className="size-3" aria-hidden /> {t('delivery.none')}</Badge>;
  }
  return (
    <div className={cn('flex flex-wrap items-start gap-x-2 gap-y-1 font-normal', className)} data-testid="invitation-delivery" data-status={status}>
      <div className="space-y-0.5">{body}</div>
      {(status === 'failed' || status === 'none') ? retry : null}
      {canReadLog && invitation.id && status !== 'none' ? (
        <Link className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" to={emailLogOfInvitation(invitation.id)} data-testid="invitation-email-log">
          <History className="size-3" aria-hidden /> {t('delivery.log')}
        </Link>
      ) : null}
    </div>
  );
}

/** How long the dialog shows "Sending…" before it says the e-mail service has not answered (the worker sends in seconds). */
export const DELIVERY_STALE_AFTER_MS = 60_000;

/**
 * The delivery of an invitation that was just issued, followed live (the invitations list polls while the e-mail is in
 * flight) — for the dialogs that show the copy link. Needs `user.view` to read the list; without it nothing is shown.
 * Still queued a minute later means no worker picked the e-mail up: the dialog says so (and points audit viewers to the
 * e-mail log) instead of spinning on "Sending…" with no end.
 */
export function LiveInvitationDelivery({ invitation }: { invitation: InvitationDto }) {
  const { t } = useTranslation('users');
  const can = useCan();
  const visible = can('user.view');
  const live = useInvitation(invitation.id, visible);
  const { sendEmail } = useMemberMutations();
  const canReadLog = useCanReadEmailLog();
  const current = live ?? invitation;
  const queued = invitationDeliveryStatus(current) === 'queued';
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!queued) return undefined;
    const timer = setTimeout(() => setStale(true), DELIVERY_STALE_AFTER_MS);
    // leaving `queued` (sent, retrying, failed) ends the wait: a later re-queue starts a fresh minute
    return () => { clearTimeout(timer); setStale(false); };
  }, [queued]);
  if (!visible) return null;
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-3" data-testid="invitation-delivery-live">
      <p className="text-xs font-medium text-muted-foreground">{t('delivery.title', { email: invitation.email })}</p>
      <InvitationDelivery invitation={current} retrying={sendEmail.isPending}
        onRetry={can('user.manage') ? () => sendEmail.mutate(invitation.id, { onSuccess: () => toast.success(t('delivery.requeued', { email: invitation.email })), onError: toastError }) : undefined} />
      {queued && stale ? (
        <p className="text-xs text-muted-foreground" data-testid="invitation-delivery-stale">
          {t('delivery.stale')}{' '}
          {canReadLog ? <Link className="font-medium text-primary underline-offset-4 hover:underline" to={emailLogOfInvitation(invitation.id)}>{t('delivery.openLog')}</Link> : null}
        </p>
      ) : null}
    </div>
  );
}
