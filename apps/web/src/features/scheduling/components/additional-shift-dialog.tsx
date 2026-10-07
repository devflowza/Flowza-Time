import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Layers } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { ApiError } from '@/lib/api-client';
import { fmtDate, fmtMinutes, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeOptions } from '@/features/employees/api';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useShiftResolution, useShifts } from '@/features/schedule/api';
import { useAdditionalShiftMutations } from '../api';
import { SCHED_NS } from '../i18n';
import { composeDayPreview } from '../model';

type Conflict = { message: string; dates: string[] };

/**
 * Assign an additional (double) shift: employee, a FIXED shift, the range (inclusive last day, open-ended allowed). The
 * composed day of the first date is shown before saving; the API checks every date of the range and answers 422 with the
 * first conflicting dates, which the dialog lists.
 */
export function AdditionalShiftDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation(SCHED_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const employees = useEmployeeOptions();
  const shifts = useShifts({ pageSize: 200, sort: 'name', status: 'active' });
  const { create } = useAdditionalShiftMutations();
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [from, setFrom] = useState(() => todayIso(tz));
  const [to, setTo] = useState('');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const fixed = useMemo(() => (shifts.data?.data ?? []).filter((s) => s.type === 'FIXED'), [shifts.data]);
  const options = useMemo(() => fixed.map((s) => ({ value: s.id, label: s.name, description: `${s.code} · ${s.startTime ?? ''}–${s.endTime ?? ''}` })), [fixed]);
  const extra = fixed.find((s) => s.id === shiftId) ?? null;
  const resolution = useShiftResolution({ employeeId, date: from });
  const primary = resolution.data?.shift ?? null;
  const composed = primary && extra ? composeDayPreview(primary, extra) : null;
  const valid = !!employeeId && !!shiftId && !!from && (!to || to >= from);

  const onSave = () => {
    if (!valid || !employeeId || !shiftId) return;
    setConflict(null);
    create.mutate({ employeeId, shiftId, effectiveFrom: from, effectiveTo: to || null }, {
      onSuccess: (r) => {
        if (r.recalculationJobId) toastJobQueued(r.recalculationJobId, navigate, t('double.recalcHint'), { to: '/attendance?tab=recalc' });
        else toast.success(t('double.created'));
        onOpenChange(false);
      },
      onError: (e) => {
        const conflicts = e instanceof ApiError && Array.isArray(e.details?.['conflicts']) ? (e.details['conflicts'] as Array<{ date: string }>).map((c) => c.date) : [];
        if (e instanceof ApiError && e.status === 422) setConflict({ message: e.message, dates: conflicts });
        else toastError(e);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('double.add')}</DialogTitle><DialogDescription>{t('double.dialogHint')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <FormField label={t('double.employee')} htmlFor="dbl-employee" required>
            <Combobox id="dbl-employee" value={employeeId} onChange={setEmployeeId} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('double.employee')} />
          </FormField>
          <FormField label={t('double.shift')} htmlFor="dbl-shift" required hint={t('double.shiftHint')}>
            <Combobox id="dbl-shift" value={shiftId} onChange={setShiftId} options={options} loading={shifts.isLoading} placeholder={t('double.shift')} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('double.from')} htmlFor="dbl-from" required><Input id="dbl-from" type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
            <FormField label={t('double.to')} htmlFor="dbl-to" optional hint={t('double.toHint')}><Input id="dbl-to" type="date" dir="ltr" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
          </div>
          {employeeId && extra ? (
            <div className="rounded-md border p-3 text-sm" data-testid="composed-day">
              <p className="mb-1 flex items-center gap-1.5 font-medium"><Layers className="size-4" aria-hidden /> {t('double.composedOn', { date: fmtDate(from) })}</p>
              {resolution.isLoading ? <p className="text-muted-foreground">{tc('common.loading')}</p>
                : !primary ? <p className="text-muted-foreground">{t('double.noPrimary', { shift: extra.name })}</p>
                : composed && composed.ok ? (
                  <p className="flex flex-wrap items-center gap-1.5 tnum">
                    <span dir="ltr">{primary.name} {primary.startTime}–{primary.endTime}</span> + <span dir="ltr">{extra.name} {extra.startTime}–{extra.endTime}</span>
                    <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
                    <span className="font-semibold" dir="ltr">{composed.start}–{composed.end}</span>
                    {composed.gapMinutes > 0 ? <span className="text-muted-foreground">{t('double.gap', { duration: fmtMinutes(composed.gapMinutes) })}</span> : null}
                  </p>
                ) : composed ? <p role="alert" className="text-destructive">{t(`double.refusal.${composed.reason}`)}</p> : null}
            </div>
          ) : null}
          {conflict ? (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" data-testid="double-conflict">
              <p>{conflict.message}</p>
              {conflict.dates.length ? <p className="mt-1 tnum">{t('double.conflictDates', { dates: conflict.dates.map((d) => fmtDate(d)).join(', ') })}</p> : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={onSave} disabled={!valid} loading={create.isPending}>{t('double.assign')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
