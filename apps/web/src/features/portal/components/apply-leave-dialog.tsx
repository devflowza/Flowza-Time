import { useMemo } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarCheck, Info } from 'lucide-react';
import type { z } from 'zod';
import { HALF_DAY_PARTS, selfLeaveRequestSchema, type SelfLeaveDto, type SelfLeaveEditInput, type SelfLeaveRecordDto, type SelfLeaveRequestInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from '@/components/ui';
import { todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { toastMutationError } from '@/features/attendance/period-locked';
import { checkLeaveApplication, findOwnOverlap, previewCalendarOf, previewLeaveDaysByMode, type CountMode, type LeaveIssue } from '@/features/leave/model';
import { useSelfLeave } from '../api';
import { useSelfLeaveActions } from '../leave-api';
import { fmtDays } from '../model';
import { TypeDot } from './parts';

type FormValues = z.input<typeof selfLeaveRequestSchema>;
interface TypePolicy { id: string; name: string; color: string | null; isPaid: boolean; countMode: CountMode; allowHalfDay: boolean; advanceNoticeDays: number; maxConsecutiveDays: number | null; compOff: boolean }

/** The earliest start date a type's notice allows (today + notice), for the message. */
const earliestStart = (today: string, notice: number): string => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + notice); return d.toISOString().slice(0, 10); };

/**
 * Apply for leave, edit a pending request (`record`: only what changed is sent; the request goes back to its approvers), or
 * use comp-off credits (`compOff`: a leave of the organisation's comp-off type, consumed on approval). The preview counts
 * the days the request charges — working days, or every calendar day for a calendar-mode type — shows the balance after it,
 * refuses what the API would refuse (half day not allowed, notice, the consecutive cap, not enough comp-off) and warns,
 * without blocking, when an ordinary request goes past the balance: HR decides.
 */
export function ApplyLeaveDialog({ open, onOpenChange, data, record, compOff }: { open: boolean; onOpenChange: (o: boolean) => void; data: SelfLeaveDto | undefined; record?: SelfLeaveRecordDto | null; compOff?: boolean }) {
  const { t } = useTranslation('portal');
  const { t: tl } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const { apply, edit } = useSelfLeaveActions();
  const today = todayIso(tz);
  const editing = !!record;
  const compOffMode = !!compOff || !!record?.compOff;
  const compOffTypeId = data?.compOff?.leaveTypeId ?? (record?.compOff ? record.leaveTypeId : null);

  const types = useMemo<TypePolicy[]>(() => {
    const ordinary = (data?.types ?? []).filter((x) => !x.compOff).map((x) => ({ id: x.id, name: x.name, color: x.color, isPaid: x.isPaid, countMode: (x.countMode ?? 'working') as CountMode, allowHalfDay: x.allowHalfDay ?? true, advanceNoticeDays: x.advanceNoticeDays ?? 0, maxConsecutiveDays: x.maxConsecutiveDays ?? null, compOff: false }));
    // the comp-off type is not in the ordinary list: it is used from the comp-off card (its policy: working days, half days allowed)
    return compOffTypeId ? [...ordinary, { id: compOffTypeId, name: tl('compOff.typeName'), color: record?.compOff ? record.color : '#6941c6', isPaid: true, countMode: 'working', allowHalfDay: true, advanceNoticeDays: 0, maxConsecutiveDays: null, compOff: true }] : ordinary;
  }, [data, compOffTypeId, record, tl]);

  const form = useForm<FormValues, unknown, SelfLeaveRequestInput>({
    resolver: zodResolver(selfLeaveRequestSchema),
    defaultValues: record
      ? { leaveTypeId: record.leaveTypeId, startDate: record.startDate, endDate: record.endDate, isHalfDay: record.isHalfDay, halfDayPart: (record.halfDayPart ?? undefined) as FormValues['halfDayPart'], reason: record.reason ?? '' }
      : { leaveTypeId: compOffMode ? compOffTypeId ?? '' : '', startDate: today, endDate: today, isHalfDay: false, reason: '' },
  });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const [leaveTypeId, startDate, endDate, isHalfDay] = useWatch({ control, name: ['leaveTypeId', 'startDate', 'endDate', 'isHalfDay'] });

  // review P2-9: the API checks a request against the balance of its START year — when the dates leave the year on screen,
  // the dialog loads that year (balances, calendar, requests) and shows no balance line until it has it
  const startYear = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? Number(startDate.slice(0, 4)) : null;
  const otherYear = !!data && startYear !== null && startYear !== data.year;
  const otherYearQuery = useSelfLeave(otherYear ? startYear! : data?.year ?? Number(today.slice(0, 4)), { enabled: open && otherYear, keepPrevious: false });
  const yearData: SelfLeaveDto | undefined = otherYear ? (otherYearQuery.isPlaceholderData ? undefined : otherYearQuery.data) : data;
  // the per-date working calendar when the API sends it (review P1-1 / P1-2: the branch of each date, rotation off days);
  // older API builds send only the current weekly offs and holidays
  const calendar = useMemo(() => previewCalendarOf(yearData?.calendar ?? data?.calendar), [yearData, data]);
  const type = types.find((x) => x.id === leaveTypeId);
  const days = startDate && endDate ? previewLeaveDaysByMode(startDate, endDate, !!isHalfDay, calendar, type?.countMode ?? 'working') : 0;
  // what is left after the other pending requests; an edited request's own days are already counted there (in its own start year)
  const ownDays = record && record.leaveTypeId === leaveTypeId && yearData && Number(record.startDate.slice(0, 4)) === yearData.year ? record.days : 0;
  const balance = yearData?.balances.find((b) => b.leaveTypeId === leaveTypeId);
  const tracked = balance ? balance.tracked ?? balance.allowanceDays !== null : false;
  const baseAvailable = type?.compOff ? yearData?.compOff?.availableAfterPendingDays ?? null : tracked ? balance?.availableAfterPendingDays ?? balance?.remainingDays ?? null : null;
  const available = baseAvailable === null || baseAvailable === undefined ? null : baseAvailable + ownDays;
  const issues: LeaveIssue[] = type && startDate && endDate && endDate >= startDate ? checkLeaveApplication({ type, isHalfDay: !!isHalfDay, days, startDate, today, availableAfterPendingDays: available }) : [];
  // B-47: a date already on leave (own pending / approved requests of the years loaded) is refused before sending
  const knownRecords = useMemo(() => {
    const seen = new Map<string, SelfLeaveRecordDto>();
    for (const r of [...(data?.records ?? []), ...(otherYear ? yearData?.records ?? [] : [])]) seen.set(r.id, r);
    return [...seen.values()];
  }, [data, yearData, otherYear]);
  const clash = startDate && endDate && endDate >= startDate ? findOwnOverlap(knownRecords, { startDate, endDate }, record?.id) : null;
  const blocking = issues.filter((i) => i.blocking && i.code !== 'NO_DAYS');
  const overBalance = issues.find((i) => i.code === 'OVER_BALANCE');
  const remainingAfter = available !== null && days > 0 ? available - days : null;

  const issueText = (i: LeaveIssue): string => {
    const name = type?.name ?? '';
    switch (i.code) {
      case 'HALF_DAY_NOT_ALLOWED': return tl('apply.issues.halfDay', { type: name });
      case 'ADVANCE_NOTICE': return tl('apply.issues.notice', { type: name, count: i.params['required'], date: earliestStart(today, i.params['required'] ?? 0) });
      case 'MAX_CONSECUTIVE': return tl('apply.issues.maxConsecutive', { type: name, count: i.params['max'] });
      case 'COMP_OFF_BALANCE': return tl('apply.issues.compOff', { count: i.params['available'] ?? 0, available: fmtDays(i.params['available'] ?? 0) });
      default: return '';
    }
  };

  const onSubmit = form.handleSubmit(async (v) => {
    const halfDayPart = v.isHalfDay ? v.halfDayPart ?? 'FIRST_HALF' : undefined;
    try {
      if (record) {
        const patch: SelfLeaveEditInput = {};
        if (v.leaveTypeId !== record.leaveTypeId) patch.leaveTypeId = v.leaveTypeId;
        if (v.startDate !== record.startDate) patch.startDate = v.startDate;
        if (v.endDate !== record.endDate) patch.endDate = v.endDate;
        if (!!v.isHalfDay !== record.isHalfDay) patch.isHalfDay = !!v.isHalfDay;
        if ((halfDayPart ?? null) !== (record.halfDayPart ?? null)) patch.halfDayPart = halfDayPart ?? null;
        if (v.reason !== (record.reason ?? '')) patch.reason = v.reason;
        if (!Object.keys(patch).length) { onOpenChange(false); return; }
        const res = await edit.mutateAsync({ id: record.id, input: patch });
        toast.success(tl('apply.updated'), { description: res.warnings?.length ? res.warnings.map((w) => w.message).join(' ') : tl('apply.resubmitted') });
      } else {
        const res = await apply.mutateAsync({ ...v, halfDayPart });
        toast.success(res.status === 'APPROVED' ? tl('apply.autoApproved') : t('apply.submitted'), { description: res.warnings?.length ? res.warnings.map((w) => w.message).join(' ') : undefined });
      }
      onOpenChange(false);
    } catch (e) { toastMutationError(e, navigate); }
  });

  const title = editing ? tl('apply.editTitle') : compOffMode ? tl('compOff.useTitle') : t('apply.title');
  const hint = editing ? tl('apply.editHint') : compOffMode ? tl('compOff.useHint') : t('apply.hint');
  const refused = blocking.length > 0 || !!clash;
  const warn = days === 0 || refused || !!overBalance;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{hint}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {compOffMode ? (
            <p className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm"><TypeDot color={type?.color ?? '#6941c6'} /><span className="font-medium">{tl('compOff.typeName')}</span>{available !== null ? <span className="text-xs text-muted-foreground tnum">· {tl('compOff.availableDays', { count: Math.max(0, available), days: fmtDays(Math.max(0, available)) })}</span> : null}</p>
          ) : (
            <FormField label={t('apply.type')} htmlFor="al-type" required error={errors.leaveTypeId?.message}>
              <Controller control={control} name="leaveTypeId" render={({ field }) => (
                <Select value={field.value || undefined} onValueChange={(v) => { field.onChange(v); const next = types.find((x) => x.id === v); if (next && !next.allowHalfDay && form.getValues('isHalfDay')) { setValue('isHalfDay', false); setValue('halfDayPart', undefined); } }}>
                  <SelectTrigger id="al-type" aria-invalid={!!errors.leaveTypeId}><SelectValue placeholder={t('apply.selectType')} /></SelectTrigger>
                  <SelectContent>
                    {types.filter((x) => !x.compOff).map((lt) => {
                      const b = yearData?.balances.find((x) => x.leaveTypeId === lt.id);
                      return (
                        <SelectItem key={lt.id} value={lt.id}>
                          <span className="flex items-center gap-2"><TypeDot color={lt.color} />{lt.name}{!lt.isPaid ? <span className="text-xs text-muted-foreground">· {t('leave.unpaid')}</span> : null}{b?.remainingDays !== null && b?.remainingDays !== undefined ? <span className="text-xs text-muted-foreground tnum">· {t('leave.remainingOf', { count: b.allowanceDays ?? 0, remaining: fmtDays(b.remainingDays), allowance: fmtDays(b.allowanceDays ?? 0) })}</span> : null}</span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )} />
            </FormField>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('apply.start')} htmlFor="al-start" required error={errors.startDate?.message}>
              <Input id="al-start" type="date" dir="ltr" {...register('startDate', { onChange: (e) => { const v = (e.target as HTMLInputElement).value; if (isHalfDay || (endDate && v > endDate)) setValue('endDate', v); } })} aria-invalid={!!errors.startDate} />
            </FormField>
            <FormField label={t('apply.end')} htmlFor="al-end" required error={errors.endDate?.message}>
              <Input id="al-end" type="date" dir="ltr" min={startDate} disabled={!!isHalfDay} {...register('endDate')} aria-invalid={!!errors.endDate} />
            </FormField>
          </div>
          {type?.allowHalfDay === false ? <p className="text-xs text-muted-foreground">{tl('apply.noHalfDay', { type: type.name })}</p> : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Controller control={control} name="isHalfDay" render={({ field }) => (
                <div className="flex items-center justify-between gap-4 rounded-md border p-3"><div><Label htmlFor="al-half">{t('apply.halfDay')}</Label><p className="text-xs text-muted-foreground">{t('apply.halfDayHint')}</p></div><Switch id="al-half" checked={!!field.value} onCheckedChange={(on) => { field.onChange(on); if (on) { setValue('endDate', form.getValues('startDate')); setValue('halfDayPart', 'FIRST_HALF'); } else setValue('halfDayPart', undefined); }} /></div>
              )} />
              {isHalfDay ? (
                <FormField label={t('apply.part')} htmlFor="al-part" error={errors.halfDayPart?.message}>
                  <Controller control={control} name="halfDayPart" render={({ field }) => (
                    <Select value={field.value ?? 'FIRST_HALF'} onValueChange={field.onChange}><SelectTrigger id="al-part"><SelectValue /></SelectTrigger><SelectContent>{HALF_DAY_PARTS.map((p) => <SelectItem key={p} value={p}>{tl(`halfDayParts.${p}`)}</SelectItem>)}</SelectContent></Select>
                  )} />
                </FormField>
              ) : null}
            </div>
          )}
          <FormField label={t('apply.reason')} htmlFor="al-reason" required hint={t('apply.reasonHint')} error={errors.reason?.message}>
            <Textarea id="al-reason" rows={3} maxLength={1000} {...register('reason')} aria-invalid={!!errors.reason} />
          </FormField>

          {startDate && endDate && endDate >= startDate ? (
            <div className={cn('flex gap-2.5 rounded-md border p-3 text-sm', refused ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100' : warn ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100' : 'bg-muted/40')} data-testid="leave-preview" aria-live="polite">
              {warn ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CalendarCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
              <div className="space-y-0.5">
                <p>{days === 0 ? t('apply.previewNone') : type?.countMode === 'calendar' ? tl('apply.previewCalendar', { count: days, days: fmtDays(days) }) : t('apply.preview', { count: days, days: fmtDays(days) })}</p>
                {type && remainingAfter !== null ? <p className="text-xs">{overBalance ? t('apply.overBalance', { type: type.name, count: available ?? 0, remaining: fmtDays(available ?? 0) }) : type.compOff ? tl('compOff.after', { count: remainingAfter, days: fmtDays(remainingAfter) }) : t('apply.balanceAfter', { type: type.name, count: remainingAfter, remaining: fmtDays(remainingAfter) })}</p> : null}
                {blocking.map((i) => <p key={i.code} className="text-xs font-medium" data-issue={i.code}>{issueText(i)}</p>)}
                {clash ? <p className="text-xs font-medium" data-issue="OVERLAP">{tl('apply.issues.overlap', { type: clash.leaveTypeName, from: clash.startDate, to: clash.endDate, status: tl(`status.${clash.status}`, { defaultValue: clash.status }) })}</p> : null}
              </div>
            </div>
          ) : null}
          {editing && record?.status === 'INFO_REQUESTED' ? <p className="flex items-start gap-2 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{tl('apply.editAnswers')}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting} disabled={days === 0 || refused}>{editing ? tl('apply.saveEdit') : t('apply.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
