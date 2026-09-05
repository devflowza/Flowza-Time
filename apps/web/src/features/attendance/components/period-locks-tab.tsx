import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Lock, LockOpen } from 'lucide-react';
import { periodLockSchema, type PeriodLockInput } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useAttendanceMutations, usePeriodLocks } from '../api';
import { shiftMonth } from '../status';
import type { PeriodLockDto } from '../types';

type LockForm = z.input<typeof periodLockSchema>;

export function LockPeriodDialog({ open, onOpenChange, preset }: { open: boolean; onOpenChange: (o: boolean) => void; preset?: Partial<LockForm> }) {
  const { t } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const branches = useBranchOptions();
  const { lockPeriod } = useAttendanceMutations();
  const lastMonth = shiftMonth(todayIso(tz).slice(0, 7), -1);
  const form = useForm<LockForm, unknown, PeriodLockInput>({ resolver: zodResolver(periodLockSchema), defaultValues: { periodStart: `${lastMonth}-01`, periodEnd: new Date(Date.UTC(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5, 7)), 0)).toISOString().slice(0, 10), reason: '', ...preset } });
  const { register, control, formState: { errors, isSubmitting } } = form;
  const onSubmit = form.handleSubmit(async (v) => {
    try { await lockPeriod.mutateAsync({ ...v, branchId: v.branchId || undefined, reason: v.reason || undefined }); toast.success(t('periods.locked')); onOpenChange(false); } catch (e) { toastError(e); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('periods.lockTitle')}</DialogTitle><DialogDescription>{t('periods.lockHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('periods.start')} htmlFor="lk-start" required error={errors.periodStart?.message}><Input id="lk-start" type="date" dir="ltr" {...register('periodStart')} aria-invalid={!!errors.periodStart} /></FormField>
            <FormField label={t('periods.end')} htmlFor="lk-end" required error={errors.periodEnd?.message}><Input id="lk-end" type="date" dir="ltr" {...register('periodEnd')} aria-invalid={!!errors.periodEnd} /></FormField>
          </div>
          <FormField label={tc('common.branch')} htmlFor="lk-branch" optional hint={t('periods.branchHint')} error={errors.branchId?.message}>
            <Controller control={control} name="branchId" render={({ field }) => <Combobox id="lk-branch" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={t('periods.allBranches')} />} />
          </FormField>
          <FormField label={t('periods.reason')} htmlFor="lk-reason" optional error={errors.reason?.message}><Textarea id="lk-reason" rows={2} {...register('reason')} /></FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}><Lock /> {t('periods.lock')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UnlockPeriodDialog({ lock, onClose }: { lock: PeriodLockDto | null; onClose: () => void }) {
  const { t } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const { unlockPeriod } = useAttendanceMutations();
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 3;
  const submit = () => { if (!lock || !valid) return; unlockPeriod.mutate({ id: lock.id, reason: reason.trim() }, { onSuccess: () => { toast.success(t('periods.unlocked')); onClose(); }, onError: toastError }); };
  return (
    <Dialog open={!!lock} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('periods.unlockTitle')}</DialogTitle><DialogDescription>{lock ? t('periods.unlockHint', { from: fmtDate(lock.periodStart), to: fmtDate(lock.periodEnd) }) : null}</DialogDescription></DialogHeader>
        <FormField label={t('periods.unlockReason')} htmlFor="ul-reason" required hint={t('periods.unlockReasonHint')} error={reason.length > 0 && !valid ? t('periods.reasonTooShort') : undefined}>
          <Textarea id="ul-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={reason.length > 0 && !valid} />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" variant="destructive" disabled={!valid} loading={unlockPeriod.isPending} onClick={submit}><LockOpen /> {t('periods.unlock')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PeriodLocksTab() {
  const { t } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const branches = useBranchOptions();
  const thisYear = Number(todayIso(tz).slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [includeUnlocked, setIncludeUnlocked] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  const [unlocking, setUnlocking] = useState<PeriodLockDto | null>(null);
  const query = useMemo(() => ({ year, branchId: branchId ?? undefined, includeUnlocked: includeUnlocked ? 'true' : 'false' }), [year, branchId, includeUnlocked]);
  const q = usePeriodLocks(query);
  const canLock = can('attendance.lock_period');
  const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="h-8 w-28" aria-label={t('periods.year')}><SelectValue /></SelectTrigger>
          <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
        </Select>
        <Combobox value={branchId} onChange={setBranchId} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
        <label className="flex items-center gap-2 text-sm"><Switch checked={includeUnlocked} onCheckedChange={setIncludeUnlocked} aria-label={t('periods.includeUnlocked')} /> {t('periods.includeUnlocked')}</label>
        {canLock ? <Button size="sm" className="ms-auto" onClick={() => setLockOpen(true)}><Lock /> {t('periods.lockTitle')}</Button> : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('periods.hint')}</p>
      <div className="rounded-lg border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading && !q.data ? <TableSkeleton cols={5} rows={4} />
          : q.data && q.data.length === 0 ? <div className="p-4"><EmptyState icon={Lock} title={t('periods.empty')} description={t('periods.emptyHint')} action={canLock ? <Button onClick={() => setLockOpen(true)}><Lock /> {t('periods.lockTitle')}</Button> : undefined} /></div>
          : (
            <Table>
              <TableHeader><TableRow><TableHead>{t('periods.period')}</TableHead><TableHead>{tc('common.branch')}</TableHead><TableHead>{tc('common.status')}</TableHead><TableHead>{t('periods.lockedAt')}</TableHead><TableHead>{t('periods.reason')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {q.data?.map((l) => (
                  <TableRow key={l.id} className={!l.active ? 'text-muted-foreground' : undefined}>
                    <TableCell className="whitespace-nowrap tnum">{fmtDate(l.periodStart)} → {fmtDate(l.periodEnd)}</TableCell>
                    <TableCell>{l.branchId ? branches.byId.get(l.branchId)?.name ?? l.branchId.slice(0, 8) : <span className="text-xs text-muted-foreground">{t('periods.allBranches')}</span>}</TableCell>
                    <TableCell>{l.active ? <Badge variant="success" dot><Lock className="size-3" /> {t('periods.statusLocked')}</Badge> : <Badge variant="neutral" dot>{t('periods.statusUnlocked')}</Badge>}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs tnum">{fmtDateTime(l.lockedAt, tz)}{!l.active && l.unlockedAt ? <span className="block text-muted-foreground">{t('periods.unlockedAt', { at: fmtDateTime(l.unlockedAt, tz) })}</span> : null}</TableCell>
                    <TableCell className="max-w-[260px] text-xs"><span className="block truncate" title={l.reason ?? undefined}>{l.reason ?? '—'}</span>{l.unlockReason ? <span className="block truncate text-muted-foreground" title={l.unlockReason}>{t('periods.unlockReasonLabel')}: {l.unlockReason}</span> : null}</TableCell>
                    <TableCell className="text-end">{l.active && canLock ? <Button size="sm" variant="outline" onClick={() => setUnlocking(l)}><LockOpen /> {t('periods.unlock')}</Button> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </div>
      <LockPeriodDialog key={String(lockOpen)} open={lockOpen} onOpenChange={setLockOpen} />
      <UnlockPeriodDialog key={unlocking?.id ?? 'none'} lock={unlocking} onClose={() => setUnlocking(null)} />
    </div>
  );
}
