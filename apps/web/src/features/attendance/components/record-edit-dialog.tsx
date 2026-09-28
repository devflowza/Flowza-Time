import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Lock, Save } from 'lucide-react';
import { MANUAL_ATTENDANCE_STATUSES, type AttendanceEngineOutcomeDto, type AttendancePreviewInput, type ManualAttendanceStatus } from '@flowza/contracts';
import { Badge, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ErrorState, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useDebounced } from '@/hooks/use-debounced';
import { ApiError } from '@/lib/api-client';
import { fmtDate, fmtMinutes, fmtTime, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeOptions } from '@/features/employees/api';
import '../workspace-i18n';
import { useRecordPreview, useWorkspaceMutations } from '../workspace-api';
import { checkOutBeforeIn, localToUtcIso, utcToLocalTime } from '../workspace-utils';
import { AttendanceStatusBadge, FlagChips } from './badges';
import { StatusSourceChip } from './source-chip';

export interface RecordEditPreset { employeeId?: string; employeeName?: string; date?: string }
const AUTO = '__auto__';

function Outcome({ o, zone, label }: { o: AttendanceEngineOutcomeDto; zone: string; label: string }) {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: ta } = useTranslation('attendance');
  return (
    <div className="min-w-0 space-y-1.5 rounded-md border bg-muted/30 p-3" data-testid={`outcome-${label}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t(`edit.${label}`)}</p>
      <div className="flex flex-wrap items-center gap-1.5"><AttendanceStatusBadge status={o.status} /><FlagChips flags={o.flags} size="xs" max={4} /></div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs tnum">
        <dt className="text-muted-foreground">{ta('columns.firstIn')}</dt><dd>{fmtTime(o.firstInAt, zone)}</dd>
        <dt className="text-muted-foreground">{ta('columns.lastOut')}</dt><dd>{fmtTime(o.lastOutAt, zone)}</dd>
        <dt className="text-muted-foreground">{ta('columns.worked')}</dt><dd>{fmtMinutes(o.workedMinutes)}</dd>
        <dt className="text-muted-foreground">{ta('columns.late')}</dt><dd>{o.lateMinutes ? fmtMinutes(o.lateMinutes) : '—'}</dd>
        <dt className="text-muted-foreground">{ta('columns.early')}</dt><dd>{o.earlyDepartureMinutes ? fmtMinutes(o.earlyDepartureMinutes) : '—'}</dd>
        <dt className="text-muted-foreground">{ta('columns.overtime')}</dt><dd>{o.overtimeMinutes ? fmtMinutes(o.overtimeMinutes) : '—'}</dd>
      </dl>
    </div>
  );
}

/**
 * HR's Add / Edit record (HR portal Prompt 6a): check-in / check-out and an optional manual status with a required reason.
 * The dialog shows the day's expected shift and the POLICY-DERIVED outcome of the proposed times (the engine run on the real
 * inputs by POST /attendance/preview, nothing written), then files the change as corrections through the correction path —
 * auto-applied for HR unless an approval workflow says otherwise, and always audited.
 */
export function RecordEditDialog({ open, onOpenChange, preset }: { open: boolean; onOpenChange: (open: boolean) => void; preset?: RecordEditPreset }) {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: ta } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const orgTz = useOrgTimezone();
  const employees = useEmployeeOptions();
  const { editRecord } = useWorkspaceMutations();
  const [employeeId, setEmployeeId] = useState<string | null>(preset?.employeeId ?? null);
  const [date, setDate] = useState<string>(preset?.date ?? todayIso(orgTz));
  const [inTime, setInTime] = useState('');
  const [outTime, setOutTime] = useState('');
  const [outNextDay, setOutNextDay] = useState(false);
  const [status, setStatus] = useState<string>(AUTO);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);
  const [initial, setInitial] = useState({ in: '', out: '', outNextDay: false });

  const base = useRecordPreview(employeeId && date ? { employeeId, date } : null);
  // the base preview keeps the previous day while the next one loads: only a response for THIS employee-day is used
  const current = base.data && base.data.employeeId === employeeId && base.data.date === date ? base.data : undefined;
  const zone = current?.timezone ?? orgTz;
  // prefill the times from the day as the engine sees it, once per (employee, date) — adjusted during render, not in an effect
  const dayKey = `${employeeId}|${date}`;
  if (current && prefilledFor !== dayKey) {
    const i = utcToLocalTime(current.current.firstInAt, zone, date);
    const o = utcToLocalTime(current.current.lastOutAt, zone, date);
    setInTime(i?.time ?? ''); setOutTime(o?.time ?? ''); setOutNextDay(o?.nextDay ?? false); setPrefilledFor(dayKey);
    setInitial({ in: i?.time ?? '', out: o?.time ?? '', outNextDay: o?.nextDay ?? false });
  }

  // only a time the user actually changed is proposed: the prefill is minute-precise, a device punch may carry seconds
  const inChanged = inTime !== initial.in;
  const outChanged = outTime !== initial.out || outNextDay !== initial.outNextDay;
  const inAt = inChanged && inTime ? localToUtcIso(date, inTime, zone) : null;
  const outAt = outChanged && outTime ? localToUtcIso(date, outTime, zone, outNextDay) : null;
  const reversed = checkOutBeforeIn(inAt ?? current?.current.firstInAt ?? null, outAt ?? current?.current.lastOutAt ?? null) && (!!inAt || !!outAt);
  const proposal = useMemo<AttendancePreviewInput | null>(() => (employeeId && date && prefilledFor === `${employeeId}|${date}` && !reversed && (inAt || outAt) ? { employeeId, date, ...(inAt ? { inAt } : {}), ...(outAt ? { outAt } : {}) } : null), [employeeId, date, prefilledFor, reversed, inAt, outAt]);
  const debounced = useDebounced(proposal, 350);
  const preview = useRecordPreview(debounced);
  const shown = preview.data && debounced && preview.data.employeeId === employeeId && preview.data.date === date ? preview.data : current;
  const plan = shown?.plan ?? [];

  const reasonOk = reason.trim().length >= 3;
  const nothing = !inAt && !outAt && status === AUTO;
  const previewError = preview.error instanceof ApiError ? preview.error.message : null;
  const canSave = !!employeeId && !!current && !current.locked && !reversed && reasonOk && !nothing && !previewError && !editRecord.isPending;

  const submit = () => {
    setTouched(true);
    if (!canSave || !employeeId) return;
    // only changed times are sent; the API files one correction per change (and none for a time that already matches)
    editRecord.mutate(
      { employeeId, date, reason: reason.trim(), ...(inAt ? { inAt } : {}), ...(outAt ? { outAt } : {}), ...(status !== AUTO ? { status: status as ManualAttendanceStatus } : {}) },
      {
        onSuccess: (res) => {
          if (res.failed) toast.warning(t('edit.partial', { count: res.corrections.length }), { description: res.failed.message });
          else toast.success(res.applied ? t('edit.applied') : t('edit.pending'), { description: t('edit.savedHint', { count: res.corrections.length }) });
          onOpenChange(false);
        },
        onError: toastError,
      },
    );
  };

  const presetName = preset?.employeeName;
  const employeeOptions = employeeId && presetName && !employees.options.some((o) => o.value === employeeId) ? [{ value: employeeId, label: presetName }, ...employees.options] : employees.options;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{current?.recordId ? t('edit.titleEdit') : t('edit.titleAdd')}</DialogTitle>
          <DialogDescription>{t('edit.subtitle')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={ta('columns.employee')} htmlFor="edit-employee" required>
              <Combobox id="edit-employee" value={employeeId} onChange={(v) => { setEmployeeId(v); setPrefilledFor(null); }} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} disabled={!!preset?.employeeId} placeholder={t('edit.pickEmployee')} />
            </FormField>
            <FormField label={tc('common.date')} htmlFor="edit-date" required>
              <Input id="edit-date" type="date" dir="ltr" value={date} max={todayIso(zone)} disabled={!!preset?.date} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setPrefilledFor(null); } }} />
            </FormField>
          </div>
          {!employeeId ? <p className="text-sm text-muted-foreground">{t('edit.pickEmployeeHint')}</p>
            : base.isLoading || (!current && base.isFetching) ? <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div>
            : base.isError ? <ErrorState error={base.error} onRetry={() => void base.refetch()} />
            : current ? (
              <>
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm" data-testid="expected-shift">
                  <span className="text-muted-foreground">{t('edit.expected')}</span>
                  {current.shift ? <><span className="font-medium">{current.shift.name}</span><span className="tnum" dir="ltr">{fmtTime(current.shift.expectedStartAt, zone)} – {fmtTime(current.shift.expectedEndAt, zone)}</span></> : <span>{ta('record.noShift')}</span>}
                  <span className="ms-auto flex items-center gap-1.5 text-xs text-muted-foreground"><span dir="ltr">{zone}</span> · {fmtDate(date, 'EEE dd MMM')}</span>
                </div>
                {current.locked ? <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert"><Lock className="size-4" /> {t('edit.locked')}</p> : null}
                <div className="grid gap-3 sm:grid-cols-3">
                  <FormField label={t('edit.checkIn')} htmlFor="edit-in"><Input id="edit-in" type="time" dir="ltr" value={inTime} onChange={(e) => setInTime(e.target.value)} /></FormField>
                  <FormField label={t('edit.checkOut')} htmlFor="edit-out" error={reversed ? t('edit.outBeforeIn') : undefined}><Input id="edit-out" type="time" dir="ltr" value={outTime} onChange={(e) => setOutTime(e.target.value)} aria-invalid={reversed} /></FormField>
                  <div className="flex items-end pb-2"><Label className="flex items-center gap-2 text-sm font-normal"><Checkbox checked={outNextDay} onCheckedChange={(v) => setOutNextDay(v === true)} aria-label={t('edit.nextDay')} /> {t('edit.nextDay')}</Label></div>
                </div>
                <FormField label={t('edit.status')} htmlFor="edit-status" hint={current.statusSource === 'MANUAL' ? t('edit.manualInForce', { status: ta(`status.${current.manualStatus ?? ''}`, { defaultValue: current.manualStatus ?? '' }) }) : t('edit.statusHint')}>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger id="edit-status" aria-label={t('edit.status')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO}>{t('edit.autoStatus')}</SelectItem>
                      {MANUAL_ATTENDANCE_STATUSES.map((s) => <SelectItem key={s} value={s}>{ta(`status.${s}`)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormField>
                <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr]" aria-live="polite">
                  <Outcome o={current.current} zone={zone} label="now" />
                  <ArrowRight className="hidden self-center text-muted-foreground sm:block rtl:rotate-180" />
                  <Outcome o={shown?.preview ?? current.preview} zone={zone} label="after" />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <StatusSourceChip source={status !== AUTO ? 'MANUAL' : current.statusSource} />
                  {status !== AUTO ? <span>{t('edit.statusWins', { status: ta(`status.${status}`) })}</span> : <span>{t('edit.policyStatus')}</span>}
                  {current.pendingCorrections > 0 ? <Badge variant="warning">{t('edit.pendingCorrections', { count: current.pendingCorrections })}</Badge> : null}
                  {preview.isFetching ? <span>{t('edit.previewing')}</span> : null}
                </div>
                {plan.length || status !== AUTO ? (
                  <p className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="edit-plan">
                    <span className="text-muted-foreground">{t('edit.willFile')}</span>
                    {plan.map((p, i) => <Badge key={i} variant="outline" className="tnum">{t(`edit.plan.${p.type}`)} <span dir="ltr">{fmtTime(p.proposedPunchedAt, zone)}</span></Badge>)}
                    {status !== AUTO ? <Badge variant="outline">{t('edit.plan.SET_STATUS')} · {ta(`status.${status}`)}</Badge> : null}
                  </p>
                ) : null}
                {previewError ? <p className="text-sm text-destructive" role="alert">{previewError}</p> : null}
                <FormField label={t('edit.reason')} htmlFor="edit-reason" required error={touched && !reasonOk ? t('edit.reasonRequired') : undefined}>
                  <Textarea id="edit-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('edit.reasonPlaceholder')} aria-invalid={touched && !reasonOk} maxLength={1000} />
                </FormField>
                {touched && nothing ? <p className="text-sm text-destructive" role="alert">{t('edit.nothing')}</p> : null}
              </>
            ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={submit} loading={editRecord.isPending} disabled={!employeeId || !current || !!current?.locked}><Save /> {t('edit.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
