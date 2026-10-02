import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Lock, Save } from 'lucide-react';
import { MANUAL_ATTENDANCE_STATUSES, type AttendanceEngineOutcomeDto, type AttendancePreviewDto, type AttendancePreviewInput, type ManualAttendanceStatus } from '@flowza/contracts';
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
import { usePendingEdits } from '../pending-edits';
import { checkOutBeforeIn, isFuturePunch, issueField, localToUtcIso, utcToLocalTime } from '../workspace-utils';
import { AttendanceStatusBadge, FlagChips } from './badges';
import { StatusSourceChip } from './source-chip';

export interface RecordEditPreset { employeeId?: string; employeeName?: string; date?: string }
const AUTO = '__auto__';

function Outcome({ o, zone, label, status }: { o: AttendanceEngineOutcomeDto; zone: string; label: string; status?: string }) {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: ta } = useTranslation('attendance');
  return (
    <div className="min-w-0 space-y-1.5 rounded-md border bg-muted/30 p-3" data-testid={`outcome-${label}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t(`edit.${label}`)}</p>
      <div className="flex flex-wrap items-center gap-1.5"><AttendanceStatusBadge status={status ?? o.status} /><FlagChips flags={o.flags} size="xs" max={4} /></div>
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

/** The "after" side when there is no outcome to show for the proposed times (refused, or still being calculated). */
function NoOutcome({ message }: { message: string }) {
  const { t } = useTranslation('attendanceWorkspace');
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-dashed p-3" data-testid="outcome-after">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('edit.after')}</p>
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

/**
 * HR's Add / Edit record (HR portal Prompt 6a): check-in / check-out and an optional manual status with a required reason.
 * The dialog shows the day's expected shift and the POLICY-DERIVED outcome of the proposed times (the engine run on the real
 * inputs by POST /attendance/preview, nothing written), then files the change as corrections through the correction path —
 * auto-applied for HR unless an approval workflow says otherwise, and always audited.
 *
 * 2026-10-02 field report: Add record opens on the day the register shows (`defaultDate`), not today; clearing a time that
 * has a punch removes that punch (REMOVE_PUNCH); the time fields stay mounted (and keep what was typed) while a new day
 * loads; the dialog closes on the API's answer and the register shows the day as updating until it is recalculated.
 */
export function RecordEditDialog({ open, onOpenChange, preset, defaultDate }: { open: boolean; onOpenChange: (open: boolean) => void; preset?: RecordEditPreset; defaultDate?: string }) {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: ta } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const orgTz = useOrgTimezone();
  const employees = useEmployeeOptions();
  const { editRecord } = useWorkspaceMutations();
  const markPending = usePendingEdits((s) => s.mark);
  const [employeeId, setEmployeeId] = useState<string | null>(preset?.employeeId ?? null);
  const [date, setDate] = useState<string>(() => {
    if (preset?.date) return preset.date;
    const today = todayIso(orgTz);
    return defaultDate && defaultDate < today ? defaultDate : today;
  });
  const [inTime, setInTime] = useState('');
  const [outTime, setOutTime] = useState('');
  const [outNextDay, setOutNextDay] = useState(false);
  const [status, setStatus] = useState<string>(AUTO);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);
  const [initial, setInitial] = useState({ in: '', out: '', outNextDay: false });
  // fields typed in since the employee / date was picked: the day's punches never overwrite them when they arrive
  const [typed, setTyped] = useState({ in: false, out: false });
  // the clock the "not in the future" rule is checked against (the API's own rule), re-read while the dialog is open
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNowMs(Date.now()), 30_000); return () => window.clearInterval(id); }, []);
  const pickDay = (next: { employeeId?: string | null; date?: string }) => {
    if (next.employeeId !== undefined) setEmployeeId(next.employeeId);
    if (next.date !== undefined) setDate(next.date);
    setPrefilledFor(null); setTyped({ in: false, out: false });
  };

  const base = useRecordPreview(employeeId && date ? { employeeId, date } : null);
  // the base preview keeps the previous day while the next one loads: only a response for THIS employee-day is used
  const current = base.data && base.data.employeeId === employeeId && base.data.date === date ? base.data : undefined;
  const zone = current?.timezone ?? orgTz;
  // prefill the times from the day as the engine sees it, once per (employee, date) — adjusted during render, not in an effect
  const dayKey = `${employeeId}|${date}`;
  if (current && prefilledFor !== dayKey) {
    const i = utcToLocalTime(current.current.firstInAt, zone, date);
    const o = utcToLocalTime(current.current.lastOutAt, zone, date);
    if (!typed.in) setInTime(i?.time ?? '');
    if (!typed.out) { setOutTime(o?.time ?? ''); setOutNextDay(o?.nextDay ?? false); }
    setPrefilledFor(dayKey);
    setInitial({ in: i?.time ?? '', out: o?.time ?? '', outNextDay: o?.nextDay ?? false });
  }
  const ready = !!current && prefilledFor === dayKey;

  // only a time the user actually changed is proposed: the prefill is minute-precise, a device punch may carry seconds
  const inChanged = inTime !== initial.in;
  const outChanged = outTime !== initial.out || outNextDay !== initial.outNextDay;
  const inAt = ready && inChanged && inTime ? localToUtcIso(date, inTime, zone) : null;
  const outAt = ready && outChanged && outTime ? localToUtcIso(date, outTime, zone, outNextDay) : null;
  // a cleared time the day has a punch for takes that punch away (REMOVE_PUNCH), as "Request correction → Remove punch" does
  const removeIn = ready && initial.in !== '' && inTime === '';
  const removeOut = ready && initial.out !== '' && outTime === '';
  const keptIn = removeIn ? null : current?.current.firstInAt ?? null;
  const keptOut = removeOut ? null : current?.current.lastOutAt ?? null;
  const reversed = checkOutBeforeIn(inAt ?? keptIn, outAt ?? keptOut) && (!!inAt || !!outAt);
  // a punch is recorded once it has happened: a time still to come (today's shift, a check-out tomorrow) is refused here, on
  // its own field, before the API is asked — the API refuses it too, but only with one message for the whole proposal
  const inFuture = isFuturePunch(inAt, nowMs);
  const outFuture = isFuturePunch(outAt, nowMs);
  const refused = reversed || inFuture || outFuture;
  const proposal = useMemo<AttendancePreviewInput | null>(() => (employeeId && date && ready && !refused && (inAt || outAt || removeIn || removeOut)
    ? { employeeId, date, ...(inAt ? { inAt } : {}), ...(outAt ? { outAt } : {}), ...(removeIn ? { removeIn: true } : {}), ...(removeOut ? { removeOut: true } : {}) }
    : null), [employeeId, date, ready, refused, inAt, outAt, removeIn, removeOut]);
  const debounced = useDebounced(proposal, 350);
  const preview = useRecordPreview(debounced);
  const forThisDay = (d: AttendancePreviewDto | undefined) => (d && d.employeeId === employeeId && d.date === date ? d : undefined);
  const shown = (debounced ? forThisDay(preview.data) : undefined) ?? current;
  const plan = shown?.plan ?? [];
  // the outcome and the refusal of exactly the times on screen — not of the times typed a moment ago (debounce, kept data)
  const settled = !!proposal && debounced === proposal;
  const previewed = settled && !preview.isPlaceholderData ? forThisDay(preview.data) : undefined;
  const apiError = settled && preview.error instanceof ApiError ? preview.error : null;

  const reasonOk = reason.trim().length >= 3;
  const nothing = !inAt && !outAt && !removeIn && !removeOut && status === AUTO;
  const previewError = apiError?.message ?? null;
  const previewErrorField = apiError ? issueField(apiError.details) : null;
  const canSave = !!employeeId && !!current && !current.locked && !refused && reasonOk && !nothing && !previewError && !editRecord.isPending;
  const stamp = (iso: string) => fmtTime(iso, zone, 'EEE dd MMM HH:mm');
  const inError = inFuture && inAt ? t('edit.future', { at: stamp(inAt) }) : previewErrorField === 'inAt' ? previewError ?? undefined : undefined;
  const outError = reversed ? t('edit.outBeforeIn') : outFuture && outAt ? t('edit.future', { at: stamp(outAt) }) : previewErrorField === 'outAt' ? previewError ?? undefined : undefined;
  // the "after" side never repeats the day as it is now when the proposed times have no outcome: refused, or not yet calculated
  const afterMessage = refused || previewError ? t('edit.afterRefused') : proposal && !previewed ? t('edit.previewing') : null;

  const submit = () => {
    setTouched(true);
    if (!canSave || !employeeId) return;
    // only changed times are sent; the API files one correction per change (and none for a time that already matches)
    editRecord.mutate(
      { employeeId, date, reason: reason.trim(), ...(inAt ? { inAt } : {}), ...(outAt ? { outAt } : {}), ...(removeIn ? { removeIn: true } : {}), ...(removeOut ? { removeOut: true } : {}), ...(status !== AUTO ? { status: status as ManualAttendanceStatus } : {}) },
      {
        onSuccess: (res) => {
          if (res.failed) toast.warning(t('edit.partial', { count: res.corrections.length }), { description: res.failed.message });
          else toast.success(res.applied ? t('edit.applied') : t('edit.pending'), { description: t('edit.savedHint', { count: res.corrections.length }) });
          // an applied correction makes the worker recalculate the day within seconds: the register shows it as updating until then
          if (res.corrections.some((c) => c.approval === 'AUTO_APPROVED')) markPending(employeeId, date, res.filedAt);
          onOpenChange(false);
        },
        onError: toastError,
      },
    );
  };

  const presetName = preset?.employeeName;
  const employeeOptions = employeeId && presetName && !employees.options.some((o) => o.value === employeeId) ? [{ value: employeeId, label: presetName }, ...employees.options] : employees.options;
  const saving = editRecord.isPending;

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
              <Combobox id="edit-employee" value={employeeId} onChange={(v) => pickDay({ employeeId: v })} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} disabled={!!preset?.employeeId || saving} placeholder={t('edit.pickEmployee')} />
            </FormField>
            <FormField label={tc('common.date')} htmlFor="edit-date" required>
              <Input id="edit-date" type="date" dir="ltr" value={date} max={todayIso(zone)} disabled={!!preset?.date || saving} onChange={(e) => { if (e.target.value) pickDay({ date: e.target.value }); }} />
            </FormField>
          </div>
          {!employeeId ? <p className="text-sm text-muted-foreground">{t('edit.pickEmployeeHint')}</p> : (
            <>
              {current ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm" data-testid="expected-shift">
                  <span className="text-muted-foreground">{t('edit.expected')}</span>
                  {current.shift ? <><span className="font-medium">{current.shift.name}</span><span className="tnum" dir="ltr">{fmtTime(current.shift.expectedStartAt, zone)} – {fmtTime(current.shift.expectedEndAt, zone)}</span></> : <span>{ta('record.noShift')}</span>}
                  <span className="ms-auto flex items-center gap-1.5 text-xs text-muted-foreground"><span dir="ltr">{zone}</span> · {fmtDate(date, 'EEE dd MMM')}</span>
                </div>
              ) : base.isError ? <ErrorState error={base.error} onRetry={() => void base.refetch()} /> : <Skeleton className="h-10 w-full" data-testid="expected-shift-loading" />}
              {current?.locked ? <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert"><Lock className="size-4" /> {t('edit.locked')}</p> : null}
              {/* the time fields stay mounted while a day loads: what is typed is kept, the day's punches fill the untouched ones */}
              <div className="grid items-start gap-3 sm:grid-cols-3">
                <FormField label={t('edit.checkIn')} htmlFor="edit-in" error={inError} hint={removeIn ? t('edit.removeIn', { time: initial.in }) : undefined}>
                  <Input id="edit-in" type="time" dir="ltr" value={inTime} disabled={saving} onChange={(e) => { setInTime(e.target.value); setTyped((v) => ({ ...v, in: true })); }} aria-invalid={!!inError} />
                </FormField>
                <FormField label={t('edit.checkOut')} htmlFor="edit-out" error={outError} hint={removeOut ? t('edit.removeOut', { time: initial.out }) : undefined}>
                  <Input id="edit-out" type="time" dir="ltr" value={outTime} disabled={saving} onChange={(e) => { setOutTime(e.target.value); setTyped((v) => ({ ...v, out: true })); }} aria-invalid={!!outError} />
                </FormField>
                <div className="flex h-9 items-center sm:mt-5"><Label className="flex items-center gap-2 text-sm font-normal"><Checkbox checked={outNextDay} disabled={saving} onCheckedChange={(v) => { setOutNextDay(v === true); setTyped((x) => ({ ...x, out: true })); }} aria-label={t('edit.nextDay')} /> {t('edit.nextDay')}</Label></div>
              </div>
              {inFuture || outFuture ? <p className="text-xs text-muted-foreground" data-testid="future-hint">{t('edit.futureHint', { now: stamp(new Date(nowMs).toISOString()), zone })}</p> : null}
              {current ? (
                <>
                  <FormField label={t('edit.status')} htmlFor="edit-status" hint={current.statusSource === 'MANUAL' ? t('edit.manualInForce', { status: ta(`status.${current.manualStatus ?? ''}`, { defaultValue: current.manualStatus ?? '' }) }) : t('edit.statusHint')}>
                    <Select value={status} onValueChange={setStatus} disabled={saving}>
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
                    {afterMessage ? <NoOutcome message={afterMessage} /> : <Outcome o={(previewed ?? current).preview} zone={zone} label="after" status={status !== AUTO ? status : undefined} />}
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
                      {plan.map((p, i) => <Badge key={i} variant="outline" className="tnum">{t(`edit.plan.${p.type}`)} <span dir="ltr">{fmtTime(p.type === 'REMOVE_PUNCH' ? p.originalPunchedAt : p.proposedPunchedAt, zone)}</span></Badge>)}
                      {status !== AUTO ? <Badge variant="outline">{t('edit.plan.SET_STATUS')} · {ta(`status.${status}`)}</Badge> : null}
                    </p>
                  ) : null}
                  {previewError && !previewErrorField ? <p className="text-sm text-destructive" role="alert">{previewError}</p> : null}
                </>
              ) : !base.isError ? <Skeleton className="h-24 w-full" /> : null}
              <FormField label={t('edit.reason')} htmlFor="edit-reason" required error={touched && !reasonOk ? t('edit.reasonRequired') : undefined}>
                <Textarea id="edit-reason" rows={2} value={reason} disabled={saving} onChange={(e) => setReason(e.target.value)} placeholder={t('edit.reasonPlaceholder')} aria-invalid={touched && !reasonOk} maxLength={1000} />
              </FormField>
              {touched && nothing && current ? <p className="text-sm text-destructive" role="alert">{t('edit.nothing')}</p> : null}
            </>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={submit} loading={saving} disabled={!employeeId || !current || !!current?.locked}><Save /> {saving ? t('edit.saving') : t('edit.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
