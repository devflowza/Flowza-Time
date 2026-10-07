import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarX, Trash2, UserPlus, X } from 'lucide-react';
import type { EmployeeGroupDto, EmployeeGroupMemberDto } from '@flowza/contracts';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, FormField, Input, Label, Skeleton, Switch } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeOptions } from '@/features/employees/api';
import { toastJobQueued } from '@/features/employees/job-toast';
import { POLICIES_NS } from '../i18n';
import { useGroupMemberMutations, useGroupMembers } from '../api';

const PAGE_SIZE = 25;

/** End a membership on an inclusive last day. */
function EndMembershipDialog({ member, onOpenChange, onEnd, pending }: { member: EmployeeGroupMemberDto | null; onOpenChange: (o: boolean) => void; onEnd: (effectiveTo: string) => void; pending: boolean }) {
  const { t } = useTranslation(POLICIES_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const [date, setDate] = useState(() => todayIso(tz));
  return (
    <Dialog open={!!member} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('members.endTitle', { name: member?.displayName ?? '' })}</DialogTitle><DialogDescription>{t('members.endHint')}</DialogDescription></DialogHeader>
        <FormField label={t('members.lastDay')} htmlFor="em-end"><Input id="em-end" type="date" dir="ltr" min={member?.effectiveFrom} value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" loading={pending} disabled={!date} onClick={() => onEnd(date)}>{t('members.end')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The members drawer of a group: who is in it (today, or every membership), add employees from a date, end or remove one. */
export function MembersDialog({ group, onOpenChange }: { group: EmployeeGroupDto | null; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation(POLICIES_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const canManage = can('attendance.manage_rules');
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const q = useGroupMembers(group?.id ?? null, { page, pageSize: PAGE_SIZE, all: all ? 'true' : 'false' });
  const { add, end, remove } = useGroupMemberMutations(group?.id ?? '');
  const employees = useEmployeeOptions();
  const [picked, setPicked] = useState<Array<{ id: string; label: string }>>([]);
  const [from, setFrom] = useState(() => todayIso(tz));
  const [to, setTo] = useState('');
  const [ending, setEnding] = useState<EmployeeGroupMemberDto | null>(null);
  const [removing, setRemoving] = useState<EmployeeGroupMemberDto | null>(null);
  const recalcToast = (jobId: string | null, done: string) => { if (jobId) toastJobQueued(jobId, navigate, t('members.recalcHint'), { to: '/attendance?tab=recalc' }); else toast.success(done); };

  const pick = (id: string | null) => {
    if (!id || picked.some((p) => p.id === id)) return;
    const o = employees.options.find((x) => x.value === id);
    setPicked((p) => [...p, { id, label: o?.label ?? id }]);
  };
  const submit = () => add.mutate({ employeeIds: picked.map((p) => p.id), effectiveFrom: from, effectiveTo: to || null }, {
    onSuccess: (r) => {
      setPicked([]);
      if (r.ended.length) toast.info(t('members.endedOthers', { count: r.ended.length }));
      recalcToast(r.recalculationJobId, t('members.added', { count: r.added.length }));
    },
    onError: toastError,
  });
  const total = q.data?.meta.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Dialog open={!!group} onOpenChange={onOpenChange}>
      <DialogContent className="start-auto end-0 top-0 h-full max-h-none w-full max-w-xl translate-x-0 translate-y-0 content-start rounded-none rtl:translate-x-0 sm:max-w-xl" data-testid="members-drawer">
        <DialogHeader><DialogTitle>{t('members.title', { name: group?.name ?? '' })}</DialogTitle><DialogDescription>{t('members.hint')}</DialogDescription></DialogHeader>

        {canManage ? (
          <section className="space-y-3 rounded-lg border p-3" aria-label={t('members.addTitle')}>
            <p className="text-sm font-medium">{t('members.addTitle')}</p>
            <div className="space-y-1.5"><Label htmlFor="gm-employee">{t('members.employee')}</Label><Combobox id="gm-employee" value={null} onChange={pick} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('members.pickEmployee')} /></div>
            {picked.length ? <div className="flex flex-wrap gap-1">{picked.map((p) => <Badge key={p.id} variant="secondary">{p.label}<button type="button" aria-label={t('members.unpick', { name: p.label })} onClick={() => setPicked((x) => x.filter((y) => y.id !== p.id))}><X className="size-3" /></button></Badge>)}</div> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('members.from')} htmlFor="gm-from" required><Input id="gm-from" type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
              <FormField label={t('members.to')} htmlFor="gm-to" optional hint={t('members.toHint')}><Input id="gm-to" type="date" dir="ltr" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
            </div>
            <p className="text-xs text-muted-foreground">{t('members.moveHint')}</p>
            <Button type="button" size="sm" disabled={!picked.length || !from} loading={add.isPending} onClick={submit}><UserPlus /> {t('members.add', { count: picked.length })}</Button>
          </section>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm"><Switch checked={all} onCheckedChange={(v) => { setAll(v); setPage(1); }} aria-label={t('members.showAll')} /> {t('members.showAll')}</label>
          <span className="text-xs text-muted-foreground tnum">{t('members.count', { count: total })}</span>
        </div>
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          : q.isLoading ? <Skeleton className="h-32 w-full" />
          : !q.data?.data.length ? <EmptyState icon={UserPlus} title={t('members.empty')} description={all ? undefined : t('members.emptyHint')} />
          : (
            <ul className="divide-y rounded-md border" data-testid="members-list">
              {q.data.data.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1"><p className="truncate font-medium">{m.displayName}</p><p className="text-xs text-muted-foreground tnum">{m.employeeNumber} · {fmtDate(m.effectiveFrom)} → {m.effectiveTo ? fmtDate(m.effectiveTo) : t('members.open')}</p></div>
                  {canManage ? <>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEnding(m)}><CalendarX /> {t('members.end')}</Button>
                    <Button type="button" size="icon" variant="ghost" aria-label={t('members.remove', { name: m.displayName })} onClick={() => setRemoving(m)}><Trash2 /></Button>
                  </> : null}
                </li>
              ))}
            </ul>
          )}
        {pages > 1 ? (
          <div className="flex items-center justify-end gap-2 text-xs">
            <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{tc('common.previous')}</Button>
            <span className="tnum">{tc('common.pageOf', { page, total: pages })}</span>
            <Button type="button" size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{tc('common.next')}</Button>
          </div>
        ) : null}

        <EndMembershipDialog key={ending?.id ?? 'none'} member={ending} onOpenChange={(o) => !o && setEnding(null)} pending={end.isPending}
          onEnd={(effectiveTo) => ending && end.mutate({ id: ending.id, effectiveTo }, { onSuccess: (r) => { setEnding(null); recalcToast(r.recalculationJobId, t('members.ended')); }, onError: toastError })} />
        <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={t('members.removeTitle', { name: removing?.displayName ?? '' })} description={t('members.removeHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
          onConfirm={() => removing && remove.mutate(removing.id, { onSuccess: (r) => { setRemoving(null); recalcToast(r.recalculationJobId, t('members.removed')); }, onError: toastError })} />
      </DialogContent>
    </Dialog>
  );
}
