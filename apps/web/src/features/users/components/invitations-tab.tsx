import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Trash2, UserPlus } from 'lucide-react';
import type { InvitationDto } from '@flowza/contracts';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useInvitations, useMemberMutations } from '../api';
import { InviteDialog } from './invite-dialog';

export function InvitationsTab() {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('user.manage');
  const tz = useOrgTimezone();
  const q = useInvitations();
  const branches = useBranchOptions(true);
  const { revoke } = useMemberMutations();
  const [revoking, setRevoking] = useState<InvitationDto | null>(null);
  const [inviting, setInviting] = useState(false);
  const [now] = useState(() => Date.now());

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('invitations.hint')}</p>
        {canManage ? <Button size="sm" onClick={() => setInviting(true)}><UserPlus /> {t('invite.title')}</Button> : null}
      </div>
      {q.isLoading ? <Skeleton className="h-48 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data || q.data.length === 0 ? (
        <EmptyState icon={Mail} title={t('invitations.empty')} description={t('invitations.emptyHint')} action={canManage ? <Button size="sm" onClick={() => setInviting(true)}><UserPlus /> {t('invite.title')}</Button> : undefined} />
      ) : (
        <div className="rounded-lg border bg-card shadow-card">
          <Table>
            <TableHeader><TableRow><TableHead>{t('fields.email')}</TableHead><TableHead>{t('fields.role')}</TableHead><TableHead>{t('fields.branchScope')}</TableHead><TableHead>{t('invitations.invitedBy')}</TableHead><TableHead>{t('invitations.expires')}</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {q.data.map((inv) => {
                const expired = new Date(inv.expiresAt).getTime() < now;
                return (
                  <TableRow key={inv.id}>
                    <TableCell dir="ltr" className="font-medium">{inv.email}</TableCell>
                    <TableCell>{inv.roleName ?? '—'}</TableCell>
                    <TableCell>{inv.allBranches ? <Badge variant="outline">{t('fields.allBranches')}</Badge> : <span className="flex flex-wrap gap-1">{inv.branchIds.map((id) => <Badge key={id} variant="secondary">{branches.byId.get(id)?.name ?? id.slice(0, 8)}</Badge>)}</span>}</TableCell>
                    <TableCell className="text-muted-foreground">{inv.invitedByName ?? '—'}</TableCell>
                    <TableCell className="tnum"><span className="inline-flex items-center gap-2">{fmtDateTime(inv.expiresAt, tz)}{expired ? <Badge variant="danger">{t('invitations.expired')}</Badge> : <Badge variant="info">{t('invitations.pending')}</Badge>}</span></TableCell>
                    <TableCell className="text-end">{canManage ? <Button variant="ghost" size="icon" className="size-8 text-destructive" aria-label={t('invitations.revoke')} onClick={() => setRevoking(inv)}><Trash2 /></Button> : null}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {inviting ? <InviteDialog open onOpenChange={setInviting} /> : null}
      <ConfirmDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title={t('invitations.revokeTitle', { email: revoking?.email ?? '' })} description={t('invitations.revokeHint')} confirmLabel={t('invitations.revoke')} destructive loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id, { onSuccess: () => { toast.success(t('invitations.revoked')); setRevoking(null); }, onError: toastError })} />
      <span className="sr-only">{tc('common.actions')}</span>
    </div>
  );
}
