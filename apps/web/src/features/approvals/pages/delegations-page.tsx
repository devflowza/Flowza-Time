import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, UserRoundCheck, X } from 'lucide-react';
import type { ApprovalDelegationDto, ApprovalEntity } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, Checkbox, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, FormField, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useDebounced } from '@/hooks/use-debounced';
import { fmtDate, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useMe, useOrgTimezone } from '@/features/me/use-me';
import { useApprovalAccess, useDelegateCandidates, useDelegationMutations, useDelegations } from '../api';

const TYPES: readonly ApprovalEntity[] = ['ATTENDANCE_CORRECTION', 'LEAVE'];

function stateOf(d: ApprovalDelegationDto, today: string): 'active' | 'revoked' | 'ended' | 'upcoming' {
  if (!d.isActive) return 'revoked';
  if (d.endsOn < today) return 'ended';
  if (d.startsOn > today) return 'upcoming';
  return 'active';
}
const TONE = { active: 'success', revoked: 'neutral', ended: 'neutral', upcoming: 'info' } as const;

function PersonPicker({ id, value, onChange, exclude, placeholder }: { id: string; value: string | null; onChange: (v: string | null) => void; exclude?: string | null; placeholder: string }) {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 250);
  const q = useDelegateCandidates(debounced);
  const options = useMemo(() => (q.data ?? []).filter((c) => c.userId !== exclude).map((c) => ({ value: c.userId, label: c.fullName || c.email, description: c.email })), [q.data, exclude]);
  return <Combobox id={id} value={value} onChange={onChange} options={options} onSearch={setSearch} loading={q.isLoading} placeholder={placeholder} clearable />;
}

/** Create a delegation for oneself (approval.delegate) or, as HR (approval.manage), for somebody else. */
export function DelegationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('approvals');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const access = useApprovalAccess();
  const myId = useMe().data?.user.id ?? null;
  const { create } = useDelegationMutations();
  const [delegator, setDelegator] = useState<string | null>(null);
  const [delegate, setDelegate] = useState<string | null>(null);
  const [startsOn, setStartsOn] = useState(todayIso(tz));
  const [endsOn, setEndsOn] = useState(todayIso(tz));
  const [types, setTypes] = useState<ApprovalEntity[]>([]);
  const [reason, setReason] = useState('');
  const who = delegator ?? myId;
  const invalid = !delegate || !startsOn || !endsOn || endsOn < startsOn || delegate === who;
  const submit = () => {
    if (invalid || !delegate) return;
    create.mutate({ delegateUserId: delegate, ...(delegator && delegator !== myId ? { delegatorUserId: delegator } : {}), entityTypes: types.length ? types : null, startsOn, endsOn, ...(reason.trim() ? { reason: reason.trim() } : {}) }, {
      onSuccess: () => { toast.success(t('delegations.created')); onOpenChange(false); }, onError: toastError,
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{access.manage ? t('delegations.addFor') : t('delegations.add')}</DialogTitle><DialogDescription>{t('delegations.subtitle')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          {access.manage ? <FormField label={t('delegations.onBehalf')} htmlFor="dlg-delegator" optional hint={t('delegations.onBehalfHint')}><PersonPicker id="dlg-delegator" value={delegator} onChange={setDelegator} placeholder={t('delegations.self')} /></FormField> : null}
          <FormField label={t('delegations.delegate')} htmlFor="dlg-delegate" required><PersonPicker id="dlg-delegate" value={delegate} onChange={setDelegate} exclude={who} placeholder={t('delegations.pickDelegate')} /></FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('delegations.startsOn')} htmlFor="dlg-from" required><Input id="dlg-from" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></FormField>
            <FormField label={t('delegations.endsOn')} htmlFor="dlg-to" required error={endsOn && startsOn && endsOn < startsOn ? t('delegations.endsOn') : undefined}><Input id="dlg-to" type="date" value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} /></FormField>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('delegations.types')}</legend>
            <p className="text-xs text-muted-foreground">{types.length ? null : t('delegations.allTypes')}</p>
            <div className="flex flex-wrap gap-4">
              {TYPES.map((ty) => (
                <div key={ty} className="flex items-center gap-2">
                  <Checkbox id={`dlg-type-${ty}`} checked={types.includes(ty)} onCheckedChange={(c) => setTypes((prev) => (c === true ? [...prev, ty] : prev.filter((x) => x !== ty)))} />
                  <Label htmlFor={`dlg-type-${ty}`}>{t(`entity.${ty}`)}</Label>
                </div>
              ))}
            </div>
          </fieldset>
          <FormField label={t('delegations.reason')} htmlFor="dlg-reason" optional><Textarea id="dlg-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" disabled={invalid} loading={create.isPending} onClick={submit}>{tc('common.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** /approvals/delegations — my delegations (both directions); with approval.manage, the organisation's. */
export default function DelegationsPage() {
  const { t } = useTranslation('approvals');
  const tz = useOrgTimezone();
  const today = todayIso(tz);
  const access = useApprovalAccess();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const q = useDelegations(access.manage ? scope : 'mine');
  const { revoke } = useDelegationMutations();
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApprovalDelegationDto | null>(null);
  const rows = q.data ?? [];
  const typesText = (d: ApprovalDelegationDto) => (d.entityTypes?.length ? d.entityTypes.map((e) => t(`entity.${e}`)).join(', ') : t('delegations.allTypes'));
  return (
    <div className="page-container space-y-4">
      <PageHeader title={t('delegations.title')} description={t('delegations.subtitle')} breadcrumbs={<Link to="/approvals" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('title')}</Link>}
        actions={access.delegate ? <Button size="sm" onClick={() => setOpen(true)}><Plus /> {access.manage ? t('delegations.addFor') : t('delegations.add')}</Button> : undefined} />
      {access.manage ? (
        <div className="flex gap-1.5" role="group">
          {(['mine', 'all'] as const).map((s) => <Button key={s} size="sm" variant={scope === s ? 'default' : 'outline'} aria-pressed={scope === s} onClick={() => setScope(s)}>{s === 'mine' ? t('delegations.scopeMine') : t('delegations.scopeAll')}</Button>)}
        </div>
      ) : null}
      <Card>
        <CardContent className="px-0 py-0">
          {q.isLoading ? <TableSkeleton cols={6} rows={3} /> : q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : rows.length === 0 ? (
            <div className="p-5"><EmptyState icon={UserRoundCheck} title={t('delegations.empty')} description={access.delegate ? t('delegations.emptyHint') : t('delegations.noPermission')} action={access.delegate ? <Button onClick={() => setOpen(true)}><Plus /> {t('delegations.add')}</Button> : undefined} /></div>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>{t('delegations.delegator')}</TableHead><TableHead>{t('delegations.delegate')}</TableHead><TableHead>{t('delegations.period')}</TableHead><TableHead>{t('delegations.types')}</TableHead><TableHead>{t('columns.status')}</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {rows.map((d) => { const st = stateOf(d, today); return (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.delegatorName ?? '—'}</TableCell>
                    <TableCell>{d.delegateName ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs tnum">{fmtDate(d.startsOn)} → {fmtDate(d.endsOn)}</TableCell>
                    <TableCell className="text-xs">{typesText(d)}{d.reason ? <span className="block text-muted-foreground">{d.reason}</span> : null}</TableCell>
                    <TableCell><Badge variant={TONE[st]}>{t(`delegations.${st}`)}</Badge></TableCell>
                    <TableCell className="text-end">{d.isActive && st !== 'ended' ? <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRevoking(d)}><X /> {t('delegations.revoke')}</Button> : null}</TableCell>
                  </TableRow>
                ); })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <DelegationDialog key={String(open)} open={open} onOpenChange={setOpen} />
      <ConfirmDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title={t('delegations.revokeTitle')} description={t('delegations.revokeHint')} confirmLabel={t('delegations.revoke')} destructive loading={revoke.isPending}
        onConfirm={() => { if (!revoking) return; revoke.mutate(revoking.id, { onSuccess: () => { toast.success(t('delegations.revokedToast')); setRevoking(null); }, onError: toastError }); }} />
    </div>
  );
}
