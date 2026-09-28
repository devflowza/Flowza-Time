import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, KeyRound, RotateCw, ShieldOff, ShieldCheck, UserPlus } from 'lucide-react';
import type { EmployeePortalAccessDto, InvitationDto, PortalAccessAddressDto, PortalAccessState } from '@flowza/contracts';
import { Badge, Button, Card, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ErrorState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea } from '@/components/ui';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { toast, toastError } from '@/lib/toast';
import { useActiveMembership, useCan, useOrgTimezone } from '@/features/me/use-me';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/users.json';
import ar from '@/locales/ar/users.json';
import { usePortalAccess, usePortalAccessMutations, useRoles } from '../api';
import { InvitationLinkDialog } from './invitation-link-dialog';

// rendered on the employee profile, outside the users pages
registerNamespace('users', en, ar);

const TONE: Record<PortalAccessState, 'neutral' | 'info' | 'success' | 'danger'> = { none: 'neutral', invited: 'info', active: 'success', suspended: 'danger' };
const DEFAULT_ROLE = '__default';
const OTHER = '__other';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Who last changed an address field and when (from the audit log), as the dialog shows it. */
function useProvenance() {
  const { t } = useTranslation('users');
  const tz = useOrgTimezone();
  return (a: PortalAccessAddressDto) => a.changedAt
    ? t('access.address.changed', { name: a.changedByName ?? t('access.address.someone'), when: fmtDateTime(a.changedAt, tz) })
    : t('access.address.noChange');
}

/**
 * "Invite to FlowZa Time" (HR portal Prompt 5 review, P0-2): the address is the administrator's CHOICE — the addresses on the
 * record are offered with their source (work / personal e-mail field) and who last changed that field and when, nothing is
 * pre-selected, and a field changed in the last 7 days by somebody else carries a warning (people who can edit an employee
 * record cannot grant logins; redirecting the invitation to their own mailbox would be an account takeover). Another address
 * can be typed in. Role (default Employee) and scope (the employee's branch) as before.
 */
function InviteDialog({ open, onOpenChange, employeeId, employeeName, access, onInvited }: { open: boolean; onOpenChange: (o: boolean) => void; employeeId: string; employeeName: string; access: EmployeePortalAccessDto; onInvited: (inv: InvitationDto) => void }) {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation();
  const roles = useRoles();
  const provenance = useProvenance();
  const { invite } = usePortalAccessMutations(employeeId);
  const addresses = access.addresses ?? [];
  // nothing is pre-selected; with no address on the record the only choice is to type one
  const [choice, setChoice] = useState<string | null>(addresses.length === 0 ? OTHER : null);
  const [typed, setTyped] = useState('');
  const [roleId, setRoleId] = useState(DEFAULT_ROLE);
  const picked = choice && choice !== OTHER ? addresses.find((a) => a.email === choice) ?? null : null;
  const email = choice === OTHER ? typed.trim() : picked?.email ?? '';
  const valid = EMAIL.test(email);
  const submit = () => {
    if (!valid) return;
    invite.mutate({ email, ...(roleId !== DEFAULT_ROLE ? { roleId } : {}) }, {
      onSuccess: (res) => { toast.success(t('access.sent', { email: res.invitation.email })); onOpenChange(false); onInvited(res.invitation); },
      onError: toastError,
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('access.inviteTitle', { name: employeeName })}</DialogTitle><DialogDescription>{t('access.inviteHint')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('access.address.legend')} <span className="text-destructive" aria-hidden>*</span></legend>
            <p className="text-xs text-muted-foreground">{addresses.length ? t('access.address.pick') : t('access.noEmail')}</p>
            <div role="radiogroup" aria-label={t('access.address.legend')} className="space-y-2" data-testid="access-addresses">
              {addresses.map((a) => (
                <label key={a.email} data-testid="access-address" className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', choice === a.email ? 'border-brand-500 bg-accent/50' : 'hover:border-brand-300')}>
                  <input type="radio" name="access-address" value={a.email} checked={choice === a.email} onChange={() => setChoice(a.email)} className="mt-0.5 accent-brand-600" />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block break-all font-medium" dir="ltr">{a.email}</span>
                    <span className="block text-xs text-muted-foreground">{t(`access.address.source.${a.source}`)} · {provenance(a)}</span>
                    {a.recentlyChangedByOther ? <span className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300" data-testid="access-address-warning"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t('access.address.recent')}</span> : null}
                  </span>
                </label>
              ))}
              <label className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', choice === OTHER ? 'border-brand-500 bg-accent/50' : 'hover:border-brand-300')}>
                <input type="radio" name="access-address" value={OTHER} checked={choice === OTHER} onChange={() => setChoice(OTHER)} className="mt-0.5 accent-brand-600" />
                <span className="font-medium">{t('access.address.other')}</span>
              </label>
            </div>
          </fieldset>
          {picked?.recentlyChangedByOther ? (
            <p role="alert" className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100" data-testid="access-address-confirm">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t('access.address.confirm', { name: picked.changedByName ?? t('access.address.someone'), email: picked.email })}
            </p>
          ) : null}
          {choice === OTHER ? (
            <FormField label={t('access.email')} htmlFor="access-email" required>
              <Input id="access-email" type="email" dir="ltr" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} aria-invalid={(typed.length > 0 && !valid) || undefined} />
            </FormField>
          ) : null}
          <FormField label={t('access.role')} htmlFor="access-role">
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger id="access-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_ROLE}>{t('access.roleDefault')}</SelectItem>
                {(roles.data ?? []).filter((r) => r.key !== 'employee' && r.key !== 'owner').map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" disabled={!valid} loading={invite.isPending} onClick={submit}><UserPlus /> {t('access.invite')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * FlowZa Time access on an employee profile (HR portal Prompt 6b, Finance B-67 … B-70, B-74): the linked login or the pending
 * invitation, and — with user.manage — invite, resend (a revoked login is restored, B-69), revoke (the login is suspended,
 * the employee link kept, B-74) and restore. Shown to user.view holders; the API decides everything again.
 */
export function PortalAccessCard({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const { t } = useTranslation('users');
  const tz = useOrgTimezone();
  const can = useCan();
  const me = useActiveMembership();
  const visible = can('user.view');
  const manage = can('user.manage');
  const q = usePortalAccess(employeeId, visible);
  const { revoke, restore, resend } = usePortalAccessMutations(employeeId);
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<'revoke' | 'restore' | null>(null);
  const [reason, setReason] = useState('');
  const [issued, setIssued] = useState<InvitationDto | null>(null);
  if (!visible) return null;
  const a = q.data;
  const doResend = () => resend.mutate(undefined, {
    onSuccess: (res) => { if (res.action === 'restored') toast.success(t('access.restored')); else { toast.success(t('access.resent', { email: res.invitation?.email ?? '' })); setIssued(res.invitation); } },
    onError: toastError,
  });
  const change = () => {
    const m = confirm === 'revoke' ? revoke : restore;
    m.mutate(reason.trim() || undefined, { onSuccess: () => { toast.success(confirm === 'revoke' ? t('access.revoked') : t('access.restored')); setConfirm(null); setReason(''); }, onError: toastError });
  };
  return (
    <Card className="mt-4 p-5" data-testid="portal-access-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-brand-700 dark:text-brand-300"><KeyRound className="size-4" aria-hidden /></span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t('access.title')}</h3>
            <p className="text-xs text-muted-foreground">{t('access.hint')}</p>
          </div>
        </div>
        {a ? <Badge variant={TONE[a.state]} dot data-testid="portal-access-state">{t(`access.state.${a.state}`)}</Badge> : null}
      </div>
      <div className="mt-3">
        {q.isLoading ? <Skeleton className="h-12 w-full" /> : q.isError || !a ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <div className="space-y-3">
            {a.membership ? (
              <p className="text-sm"><span className="font-medium" dir="ltr">{a.membership.email}</span> · {a.membership.roleName} · <span className="text-muted-foreground">{a.membership.lastLoginAt ? t('access.lastLogin', { when: fmtRelative(a.membership.lastLoginAt) }) : t('access.never')}</span></p>
            ) : null}
            {a.invitation ? <p className="text-sm text-muted-foreground">{a.invitation.expired ? t('access.invitationExpired', { email: a.invitation.email, date: fmtDateTime(a.invitation.expiresAt, tz) }) : t('access.invitation', { email: a.invitation.email, date: fmtDateTime(a.invitation.expiresAt, tz) })}</p> : null}
            {a.employeeLeft ? <p className="text-sm text-muted-foreground" role="note">{t('access.left')}</p> : null}
            {/* nobody changes their own access (review P0-1): the controls are offered for other people's records only */}
            {manage && !a.employeeLeft && !(a.membership && me && a.membership.id === me.membershipId) ? (
              <div className="flex flex-wrap gap-2">
                {a.state === 'none' ? <Button size="sm" onClick={() => setInviting(true)}><UserPlus /> {t('access.invite')}</Button> : null}
                {a.state === 'invited' ? <Button size="sm" variant="outline" loading={resend.isPending} onClick={doResend}><RotateCw /> {t('access.resend')}</Button> : null}
                {a.state === 'suspended' ? <Button size="sm" variant="outline" onClick={() => setConfirm('restore')}><ShieldCheck /> {t('access.restore')}</Button> : null}
                {a.state === 'active' || a.state === 'invited' ? <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirm('revoke')}><ShieldOff /> {t('access.revoke')}</Button> : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
      {inviting && a ? <InviteDialog open onOpenChange={setInviting} employeeId={employeeId} employeeName={employeeName} access={a} onInvited={setIssued} /> : null}
      <ConfirmDialog open={!!confirm} onOpenChange={(o) => { if (!o) { setConfirm(null); setReason(''); } }} title={confirm === 'revoke' ? t('access.revokeTitle', { name: employeeName }) : t('access.restoreTitle', { name: employeeName })}
        description={confirm === 'revoke' ? t('access.revokeHint') : t('access.restoreHint')} confirmLabel={confirm === 'revoke' ? t('access.revoke') : t('access.restore')} destructive={confirm === 'revoke'} loading={revoke.isPending || restore.isPending} onConfirm={change}>
        <Textarea aria-label={t('access.reason')} placeholder={t('access.reason')} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmDialog>
      <InvitationLinkDialog invitation={issued} title={t('access.sent', { email: issued?.email ?? '' })} onClose={() => setIssued(null)} />
    </Card>
  );
}
