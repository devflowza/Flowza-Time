import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, UserRound } from 'lucide-react';
import type { SelfShiftDayDto } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { PA_NS } from '../attendance-i18n';
import { useSwapCandidates, useSwapMutations } from '../attendance-api';
import { shiftLabel } from '../shift-format';

/** Days a swap can be asked for: working days with a shift, not on leave, not already covered by a swap. */
export const swappableDays = (days: readonly SelfShiftDayDto[]): SelfShiftDayDto[] => days.filter((d) => d.shift && !d.isOff && !d.onLeave && !d.holidayName && !d.swap);

/**
 * Ask to swap shifts with a colleague for one day: the employee works the colleague's shift and the colleague works theirs.
 * The line manager decides; an approved swap becomes two one-day assignments.
 */
export function SwapDialog({ open, onOpenChange, days, defaultDate }: { open: boolean; onOpenChange: (o: boolean) => void; days: readonly SelfShiftDayDto[]; defaultDate?: string | null }) {
  const { t } = useTranslation(PA_NS);
  const { t: tc } = useTranslation();
  const { create } = useSwapMutations();
  const options = swappableDays(days);
  const [date, setDate] = useState<string | null>(defaultDate ?? options[0]?.date ?? null);
  const [search, setSearch] = useState('');
  const [withId, setWithId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const candidates = useSwapCandidates(open ? date : null, search);
  const mine = options.find((d) => d.date === date)?.shift ?? null;
  const reasonShort = reason.trim().length < 3;

  const submit = () => {
    setTouched(true);
    if (!date || !withId || reasonShort) return;
    create.mutate({ date, withEmployeeId: withId, reason: reason.trim() }, {
      onSuccess: () => { toast.success(t('swap.submitted')); onOpenChange(false); },
      onError: toastError,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('swap.title')}</DialogTitle><DialogDescription>{t('swap.hint')}</DialogDescription></DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <FormField label={t('swap.date')} htmlFor="swap-date" required error={touched && !date ? t('swap.dateRequired') : undefined}>
            <Select value={date ?? undefined} onValueChange={(v) => { setDate(v); setWithId(null); }} disabled={options.length === 0}>
              <SelectTrigger id="swap-date"><SelectValue placeholder={options.length ? t('swap.pickDate') : t('swap.noDays')} /></SelectTrigger>
              <SelectContent>{options.map((d) => <SelectItem key={d.date} value={d.date}><span className="tnum">{fmtDate(d.date, 'EEE dd MMM')}</span> · {d.shift ? shiftLabel(d.shift) : ''}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          {mine ? <p className="text-xs text-muted-foreground">{t('swap.yourShift')}: <span className="font-medium text-foreground">{shiftLabel(mine)}</span></p> : null}
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('swap.colleague')}<span className="ms-0.5 text-destructive" aria-hidden>*</span></p>
            <div className="relative">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('swap.search')} className="ps-8" aria-label={t('swap.search')} />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border" role="radiogroup" aria-label={t('swap.colleague')}>
              {!date ? null : candidates.isLoading ? <div className="space-y-2 p-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>
                : (candidates.data ?? []).length === 0 ? <p className="p-3 text-sm text-muted-foreground">{t('swap.noCandidates')}</p>
                : (candidates.data ?? []).map((c) => (
                  <button key={c.employeeId} type="button" role="radio" aria-checked={withId === c.employeeId} disabled={!c.eligible} onClick={() => setWithId(c.employeeId)}
                    className={cn('flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-start text-sm last:border-b-0 disabled:opacity-50', withId === c.employeeId ? 'bg-accent' : 'hover:bg-accent/40')}>
                    <span className="flex min-w-0 items-center gap-2"><UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="truncate font-medium">{c.displayName}</span><span className="font-mono text-xs text-muted-foreground" dir="ltr">{c.employeeNumber}</span></span>
                    <span className="shrink-0 text-xs">{c.eligible ? (c.shift ? shiftLabel(c.shift) : t('shift.off')) : <Badge variant="neutral">{t('swap.ineligible')}</Badge>}</span>
                  </button>
                ))}
            </div>
            {touched && !withId ? <p className="text-xs text-destructive" role="alert">{t('swap.colleagueRequired')}</p> : null}
          </div>
          <FormField label={t('swap.reason')} htmlFor="swap-reason" required error={touched && reasonShort ? t('swap.reasonTooShort') : undefined}>
            <Textarea id="swap-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending} disabled={options.length === 0}>{t('swap.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
