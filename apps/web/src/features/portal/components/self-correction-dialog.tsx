import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import { SELF_CORRECTION_TYPES, createCorrectionSchema, type CreateCorrectionInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useEmployeeId } from '@/features/me/use-me';
import { useAttendanceEvents } from '@/features/attendance/api';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useCorrectionMutations } from '@/features/corrections/api';
import { localToUtcIso } from '@/features/corrections/time';

type FormValues = z.input<typeof createCorrectionSchema>;
const DIRECTIONS = ['PUNCH_IN', 'PUNCH_OUT', 'PUNCH'] as const;

/**
 * An employee asks for a punch correction on one of their own days (attendance.request_correction). Only punch changes
 * are offered — status overrides stay with HR — and the request always goes through the approval workflow. Times are
 * entered in the day's own (branch) timezone and sent as UTC.
 */
export function SelfCorrectionDialog({ open, onOpenChange, date, timezone }: { open: boolean; onOpenChange: (o: boolean) => void; date: string | null; timezone: string }) {
  const { t } = useTranslation('portal');
  const { t: ta } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const employeeId = useEmployeeId() ?? '';
  const { create } = useCorrectionMutations();
  const day = date ?? todayIso(timezone);
  const form = useForm<FormValues, unknown, CreateCorrectionInput>({ resolver: zodResolver(createCorrectionSchema), defaultValues: { employeeId, attendanceDate: day, type: 'ADD_PUNCH', proposedEventType: 'PUNCH_IN', reason: '' } });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const type = useWatch({ control, name: 'type' }) ?? 'ADD_PUNCH';
  const needsPunch = type === 'ADD_PUNCH' || type === 'EDIT_PUNCH';
  const needsEvent = type === 'EDIT_PUNCH' || type === 'REMOVE_PUNCH';
  const [punchTime, setPunchTime] = useState('');

  const range = useMemo(() => { const d = DateTime.fromISO(day); return { from: d.minus({ days: 1 }).toISODate()!, to: d.plus({ days: 1 }).toISODate()! }; }, [day]);
  const events = useAttendanceEvents({ employeeId, ...range }, open && needsEvent);
  const eventOptions = useMemo(() => (events.data ?? []).filter((e) => !e.voidedAt).map((e) => ({ id: e.id, label: `${fmtDateTime(e.punchedAt, timezone, 'dd MMM HH:mm')} · ${ta(`eventType.${e.eventType}`, { defaultValue: e.eventType })}` })), [events.data, timezone, ta]);

  const submit = form.handleSubmit(async (v) => {
    try {
      await create.mutateAsync({ employeeId, attendanceDate: day, type: v.type, reason: v.reason, originalEventId: needsEvent ? v.originalEventId : undefined, proposedPunchedAt: needsPunch ? v.proposedPunchedAt : undefined, proposedEventType: needsPunch ? v.proposedEventType : undefined });
      toast.success(t('correction.submitted'));
      onOpenChange(false);
    } catch (e) { toastMutationError(e, navigate); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('correction.title')}</DialogTitle><DialogDescription>{t('correction.hint')}</DialogDescription></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (needsPunch) setValue('proposedPunchedAt', localToUtcIso(day, punchTime, timezone) ?? undefined); void submit(); }} className="space-y-4" noValidate>
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm"><span className="text-muted-foreground">{t('correction.date')}:</span> <span className="font-medium tnum">{fmtDate(day, 'EEEE, dd MMM yyyy')}</span></p>
          <FormField label={t('correction.type')} htmlFor="sc-type" required error={errors.type?.message}>
            <Controller control={control} name="type" render={({ field }) => (
              <Select value={field.value} onValueChange={(v) => { field.onChange(v); setValue('originalEventId', undefined); }}>
                <SelectTrigger id="sc-type"><SelectValue /></SelectTrigger>
                <SelectContent>{SELF_CORRECTION_TYPES.map((s) => <SelectItem key={s} value={s}>{t(`correction.types.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          {needsEvent ? (
            <FormField label={t('correction.punch')} htmlFor="sc-event" required error={errors.originalEventId?.message}>
              <Controller control={control} name="originalEventId" render={({ field }) => (
                <Select value={field.value ?? undefined} onValueChange={field.onChange} disabled={events.isLoading || eventOptions.length === 0}>
                  <SelectTrigger id="sc-event" aria-invalid={!!errors.originalEventId}><SelectValue placeholder={eventOptions.length === 0 && !events.isLoading ? t('correction.noPunches') : t('correction.selectPunch')} /></SelectTrigger>
                  <SelectContent>{eventOptions.map((o) => <SelectItem key={o.id} value={o.id}><span className="tnum" dir="ltr">{o.label}</span></SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
          ) : null}
          {needsPunch ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('correction.time', { zone: timezone })} htmlFor="sc-time" required error={errors.proposedPunchedAt?.message}>
                <Input id="sc-time" type="time" step={60} dir="ltr" className="tnum" value={punchTime} onChange={(e) => { setPunchTime(e.target.value); setValue('proposedPunchedAt', localToUtcIso(day, e.target.value, timezone) ?? undefined); }} aria-invalid={!!errors.proposedPunchedAt} />
              </FormField>
              <FormField label={t('correction.direction')} htmlFor="sc-dir">
                <Controller control={control} name="proposedEventType" render={({ field }) => (
                  <Select value={field.value ?? 'PUNCH_IN'} onValueChange={field.onChange}><SelectTrigger id="sc-dir"><SelectValue /></SelectTrigger><SelectContent>{DIRECTIONS.map((d) => <SelectItem key={d} value={d}>{ta(`eventType.${d}`, { defaultValue: d })}</SelectItem>)}</SelectContent></Select>
                )} />
              </FormField>
            </div>
          ) : null}
          <FormField label={t('correction.reason')} htmlFor="sc-reason" required hint={t('correction.reasonHint')} error={errors.reason?.message}>
            <Textarea id="sc-reason" rows={3} maxLength={1000} {...register('reason')} aria-invalid={!!errors.reason} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{t('correction.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
