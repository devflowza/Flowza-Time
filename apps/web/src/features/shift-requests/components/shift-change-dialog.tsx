import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { SHIFT_CHANGE_AHEAD_DAYS, SHIFT_CHANGE_KINDS, SHIFT_CHANGE_MAX_DAYS, type ShiftChangeKind } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { shiftLabel } from '@/features/portal/shift-format';
import { SR_NS } from '../i18n';
import { useShiftChangeMutations, useShiftChangeOptions } from '../api';

const plusDays = (iso: string, n: number) => DateTime.fromISO(iso, { zone: 'utc' }).plus({ days: n }).toISODate() ?? iso;
const daysIn = (from: string, to: string) => Math.round(DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days) + 1;

/**
 * Ask to work ANOTHER shift (a change) or a SECOND shift (an additional shift — a double shift, offered only when round-the-clock
 * scheduling is on) for a range of days, from today up to SHIFT_CHANGE_AHEAD_DAYS ahead and at most SHIFT_CHANGE_MAX_DAYS long.
 * The shifts on offer are the organisation's active ones (an additional shift must be a fixed one); the API checks the rest
 * (the shift already worked, a double shift that cannot be combined, a locked period) and its message is shown as is.
 */
export function ShiftChangeDialog({ open, onOpenChange, today, additionalAllowed, defaultDate }: { open: boolean; onOpenChange: (o: boolean) => void; today: string; additionalAllowed: boolean; defaultDate?: string | null }) {
  const { t } = useTranslation(SR_NS);
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const { create } = useShiftChangeMutations();
  const kinds: readonly ShiftChangeKind[] = additionalAllowed ? SHIFT_CHANGE_KINDS : ['CHANGE'];
  const [kind, setKind] = useState<ShiftChangeKind>('CHANGE');
  const [from, setFrom] = useState(defaultDate ?? today);
  const [to, setTo] = useState(defaultDate ?? today);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const lastStart = plusDays(today, SHIFT_CHANGE_AHEAD_DAYS);
  const options = useShiftChangeOptions(open && from && from >= today && from <= lastStart ? from : null);
  const shifts = (options.data?.shifts ?? []).filter((s) => kind === 'CHANGE' || s.type === 'FIXED');
  const current = options.data?.current;

  const errors = {
    from: !from ? t('dialog.errors.from') : from < today ? t('dialog.errors.past') : from > lastStart ? t('dialog.errors.tooFar', { days: SHIFT_CHANGE_AHEAD_DAYS }) : undefined,
    to: !to ? t('dialog.errors.to') : from && to < from ? t('dialog.errors.order') : from && daysIn(from, to) > SHIFT_CHANGE_MAX_DAYS ? t('dialog.errors.tooLong', { days: SHIFT_CHANGE_MAX_DAYS }) : undefined,
    shift: !shiftId || !shifts.some((s) => s.id === shiftId) ? t('dialog.errors.shift') : undefined,
    reason: reason.trim().length < 3 ? t('dialog.errors.reason') : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  const submit = () => {
    setTouched(true);
    if (invalid || !shiftId) return;
    create.mutate({ kind, fromDate: from, toDate: to, shiftId, reason: reason.trim() }, {
      onSuccess: () => { toast.success(t('dialog.submitted')); onOpenChange(false); },
      onError: (e) => toastMutationError(e, (path) => void navigate(path)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('dialog.title')}</DialogTitle><DialogDescription>{t('dialog.hint')}</DialogDescription></DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {kinds.length > 1 ? (
            <FormField label={t('dialog.kind')} htmlFor="sc-kind" required hint={t(`kindHints.${kind}`)}>
              <Select value={kind} onValueChange={(v) => { setKind(v as ShiftChangeKind); setShiftId(null); }}>
                <SelectTrigger id="sc-kind"><SelectValue /></SelectTrigger>
                <SelectContent>{kinds.map((k) => <SelectItem key={k} value={k}>{t(`kinds.${k}`)}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('dialog.from')} htmlFor="sc-from" required error={touched ? errors.from : undefined}>
              <Input id="sc-from" type="date" dir="ltr" className="tnum" value={from} min={today} max={lastStart} onChange={(e) => { const v = e.target.value; setFrom(v); if (v && (!to || to < v)) setTo(v); }} />
            </FormField>
            <FormField label={t('dialog.to')} htmlFor="sc-to" required error={touched ? errors.to : undefined}>
              <Input id="sc-to" type="date" dir="ltr" className="tnum" value={to} min={from || today} max={from ? plusDays(from, SHIFT_CHANGE_MAX_DAYS - 1) : undefined} onChange={(e) => setTo(e.target.value)} />
            </FormField>
          </div>
          {current && from ? (
            <p className="-mt-2 text-xs text-muted-foreground" data-testid="sc-current">
              {current.shift ? t('dialog.current', { date: fmtDate(from, 'EEE dd MMM'), shift: shiftLabel(current.shift) }) : t('dialog.currentNone', { date: fmtDate(from, 'EEE dd MMM') })}
            </p>
          ) : null}
          <FormField label={t('dialog.shift')} htmlFor="sc-shift" required error={touched ? errors.shift : undefined}>
            {options.isLoading ? <Skeleton className="h-9 w-full" /> : (
              <Select value={shiftId ?? undefined} onValueChange={setShiftId} disabled={shifts.length === 0}>
                <SelectTrigger id="sc-shift"><SelectValue placeholder={shifts.length ? t('dialog.pickShift') : t('dialog.noShifts')} /></SelectTrigger>
                <SelectContent>
                  {shifts.map((s) => <SelectItem key={s.id} value={s.id}><span dir="auto">{shiftLabel({ name: s.name, type: s.type, startTime: s.startTime, endTime: s.endTime, requiredMinutes: null })}</span></SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField label={t('dialog.reason')} htmlFor="sc-reason" required error={touched ? errors.reason : undefined}>
            <Textarea id="sc-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending}>{t('dialog.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
