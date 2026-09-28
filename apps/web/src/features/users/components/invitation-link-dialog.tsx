import { useTranslation } from 'react-i18next';
import { AlertTriangle, MailCheck } from 'lucide-react';
import type { InvitationDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { CopyButton } from '@/features/audit/components/copy-button';
import { invitationUrl } from '@/features/auth/invitation-url';

/**
 * A freshly issued invitation (resend, or an invitation from an employee profile): it was e-mailed, and the copy link is shown
 * here ONCE — only its hash is stored — for an organisation whose outbound e-mail is not configured yet.
 */
export function InvitationLinkDialog({ invitation, title, onClose }: { invitation: InvitationDto | null; title: string; onClose: () => void }) {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const link = invitation?.token ? invitationUrl(invitation.token) : null;
  return (
    <Dialog open={!!invitation} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MailCheck className="size-5 text-emerald-600" /> {title}</DialogTitle>
          <DialogDescription>{t('resend.done', { email: invitation?.email ?? '' })}</DialogDescription>
        </DialogHeader>
        {link && invitation ? (
          <div className="space-y-2">
            <Label htmlFor="invitation-link">{tc('auth.inviteLinkLabel')}</Label>
            <div className="flex items-center gap-2">
              <Input id="invitation-link" readOnly value={link} dir="ltr" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <CopyButton value={link} variant="outline" label={tc('auth.inviteCopyLink')} />
            </div>
            <p className="text-xs text-muted-foreground">{tc('auth.inviteLinkHint')}</p>
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {t('invite.tokenOnce', { expires: fmtDateTime(invitation.expiresAt, tz) })}</p>
          </div>
        ) : null}
        <DialogFooter><Button onClick={onClose}>{tc('common.close')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
