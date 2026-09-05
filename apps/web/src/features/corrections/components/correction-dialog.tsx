import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import { ATTENDANCE_EVENT_TYPES, ATTENDANCE_STATUSES, CORRECTION_TYPES, createCorrectionSchema, type CreateCorrectionInput } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDateTime, todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useEmployee, useEmployeeOptions } from '@/features/employees/api';
import { useAttendanceEvents } from '@/features/attendance/api';
import { toastMutationError } from '@/features/attendance/period-locked';
import type { CorrectionPreset } from '@/features/attendance/components/record-dialog';
import { useCorrectionMutations } from '../api';
import { localToUtcIso } from '../time';

type FormValues = z.input<typeof createCorrectionSchema>;
const NONE = '__none__';

/**
 * Request an attendance correction. ADD/EDIT punch times are entered in the employee's *branch* timezone and converted to
 * UTC ISO with Luxon; EDIT/REMOVE pick an existing (non-voided) event around the attendance date; SET_STATUS picks a status.
 * Validation uses createCorrectionSchema — the same schema the API validates.
 */
export function CorrectionDialog({ open, onOpenChange, preset, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; preset?: CorrectionPreset; onCreated?: (id: string) => void }) {
  const { t } = useTranslation('corrections');
  const { t: ta } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const orgTz = useOrgTimezone();
  const navigate = useNavigate();
  const { create } = useCorrectionMutations();
  const employees = useEmployeeOptions();
  const branches = useBranchOptions();
  const form = useForm<FormValues, unknown, CreateCorrectionInput>({ resolver: zodResolver(createCorrectionSchema), defaultValues: { employeeId: preset?.employeeId ?? '', attendanceDate: preset?.attendanceDate ?? todayIso(orgTz), type: 'ADD_PUNCH', reason: '', proposedEventType: 'PUNCH' } });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const employeeId = useWatch({ control, name: 'employeeId' });
  const attendanceDate = useWatch({ control, name: 'attendanceDate' });
  const type = useWatch({ control, name: 'type' }) ?? 'ADD_PUNCH';
  const proposedPunchedAt = useWatch({ control, name: 'proposedPunchedAt' });
  const employee = useEmployee(employeeId || undefined);
  const zone = preset?.timezone && preset.employeeId === employeeId ? preset.timezone : (employee.data?.branchId ? branches.byId.get(employee.data.branchId)?.timezone : undefined) ?? orgTz;
  const needsPunch = type === 'ADD_PUNCH' || type === 'EDIT_PUNCH';
  const needsEvent = type === 'EDIT_PUNCH' || type === 'REMOVE_PUNCH';
  const [punchDate, setPunchDate] = useState(preset?.attendanceDate ?? todayIso(orgTz));
  const [punchTime, setPunchTime] = useState('');
  const syncPunchedAt = (d = punchDate, tm = punchTime) => setValue('proposedPunchedAt', localToUtcIso(d, tm, zone) ?? undefined, { shouldValidate: false });

  const range = useMemo(() => { const d = DateTime.fromISO(attendanceDate ?? ''); return d.isValid ? { from: d.minus({ days: 1 }).toISODate()!, to: d.plus({ days: 1 }).toISODate()! } : { from: undefined, to: undefined }; }, [attendanceDate]);
  const events = useAttendanceEvents({ employeeId, ...range }, needsEvent);
  const eventOptions = useMemo(() => (events.data ?? []).filter((e) => !e.voidedAt).map((e) => ({ value: e.id, label: `${fmtDateTime(e.punchedAt, zone, 'dd MMM HH:mm:ss')} · ${ta(`eventType.${e.eventType}`, { defaultValue: e.eventType })}`, description: e.deviceName ?? ta(`eventSource.${e.source}`, { defaultValue: e.source }) })), [events.data, zone, ta]);
  const employeeOptions = useMemo(() => (preset?.employeeId && !employees.options.some((o) => o.value === preset.employeeId) ? [{ value: preset.employeeId, label: preset.employeeName ?? preset.employeeId }, ...employees.options] : employees.options), [employees.options, preset]);

  const submit = form.handleSubmit(async (values) => {
    try {
      const payload: CreateCorrectionInput = { ...values, originalEventId: needsEvent ? values.originalEventId : undefined, proposedPunchedAt: needsPunch ? values.proposedPunchedAt : undefined, proposedEventType: needsPunch ? values.proposedEventType : undefined, proposedStatus: type === 'SET_STATUS' ? values.proposedStatus : undefined };
      const res = await create.mutateAsync(payload);
      toast.success(res.approval === 'AUTO_APPROVED' ? t('dialog.autoApproved') : t('dialog.submitted'));
      onOpenChange(false);
      onCreated?.(res.id);
    } catch (e) { toastMutationError(e, navigate); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{t('dialog.title')}</DialogTitle><DialogDescription>{t('dialog.hint')}</DialogDescription></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (needsPunch) syncPunchedAt(); void submit(); }} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('fields.employee')} htmlFor="cor-emp" required error={errors.employeeId?.message}>
              <Controller control={control} name="employeeId" render={({ field }) => <Combobox id="cor-emp" value={field.value || null} onChange={(v) => { field.onChange(v ?? ''); setValue('originalEventId', undefined); }} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('fields.selectEmployee')} aria-invalid={!!errors.employeeId} />} />
            </FormField>
            <FormField label={t('fields.attendanceDate')} htmlFor="cor-date" required error={errors.attendanceDate?.message}>
              <Input id="cor-date" type="date" dir="ltr" {...register('attendanceDate', { onChange: (e) => { const v = (e.target as HTMLInputElement).value; if (v) { setPunchDate(v); syncPunchedAt(v, punchTime); } setValue('originalEventId', undefined); } })} aria-invalid={!!errors.attendanceDate} />
            </FormField>
            <FormField label={t('fields.type')} htmlFor="cor-type" required error={errors.type?.message} className="sm:col-span-2">
              <Controller control={control} name="type" render={({ field }) => (
                <Select value={field.value ?? 'ADD_PUNCH'} onValueChange={field.onChange}>
                  <SelectTrigger id="cor-type"><SelectValue /></SelectTrigger>
                  <SelectContent>{CORRECTION_TYPES.map((s) => <SelectItem key={s} value={s}>{ta(`correctionType.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
              <p className="text-xs text-muted-foreground">{t(`typeHint.${type}`)}</p>
            </FormField>
          </div>

          {needsEvent ? (
            <FormField label={t('fields.originalEvent')} htmlFor="cor-event" required error={errors.originalEventId?.message} hint={events.isError ? t('fields.eventsUnavailable') : t('fields.originalEventHint')}>
              <Controller control={control} name="originalEventId" render={({ field }) => <Combobox id="cor-event" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} options={eventOptions} loading={events.isLoading} disabled={!employeeId} placeholder={employeeId ? t('fields.selectEvent') : t('fields.selectEmployeeFirst')} emptyText={t('fields.noEvents')} aria-invalid={!!errors.originalEventId} />} />
            </FormField>
          ) : null}

          {needsPunch ? (
            <div className="grid gap-4 rounded-md border bg-muted/30 p-3 sm:grid-cols-3">
              <FormField label={t('fields.punchDate')} htmlFor="cor-pdate" required>
                <Input id="cor-pdate" type="date" dir="ltr" value={punchDate} onChange={(e) => { setPunchDate(e.target.value); syncPunchedAt(e.target.value, punchTime); }} />
              </FormField>
              <FormField label={t('fields.punchTime', { zone })} htmlFor="cor-ptime" required error={errors.proposedPunchedAt?.message}>
                <Input id="cor-ptime" type="time" step={60} dir="ltr" className="tnum" value={punchTime} onChange={(e) => { setPunchTime(e.target.value); syncPunchedAt(punchDate, e.target.value); }} aria-invalid={!!errors.proposedPunchedAt} />
              </FormField>
              <FormField label={t('fields.eventType')} htmlFor="cor-etype" error={errors.proposedEventType?.message}>
                <Controller control={control} name="proposedEventType" render={({ field }) => (
                  <Select value={field.value ?? 'PUNCH'} onValueChange={field.onChange}>
                    <SelectTrigger id="cor-etype"><SelectValue /></SelectTrigger>
                    <SelectContent>{ATTENDANCE_EVENT_TYPES.map((s) => <SelectItem key={s} value={s}>{ta(`eventType.${s}`)}</SelectItem>)}</SelectContent>
                  </Select>
                )} />
              </FormField>
              <p className="text-xs text-muted-foreground sm:col-span-3" dir="ltr" data-testid="utc-preview">{proposedPunchedAt ? t('fields.storedAs', { utc: proposedPunchedAt, zone }) : t('fields.enterTime', { zone })}</p>
            </div>
          ) : null}

          {type === 'SET_STATUS' ? (
            <FormField label={t('fields.proposedStatus')} htmlFor="cor-status" required error={errors.proposedStatus?.message}>
              <Controller control={control} name="proposedStatus" render={({ field }) => (
                <Select value={field.value ?? NONE} onValueChange={(v) => field.onChange(v === NONE ? undefined : v)}>
                  <SelectTrigger id="cor-status" aria-invalid={!!errors.proposedStatus}><SelectValue placeholder={t('fields.selectStatus')} /></SelectTrigger>
                  <SelectContent>{ATTENDANCE_STATUSES.filter((s) => s !== 'PENDING').map((s) => <SelectItem key={s} value={s}>{ta(`status.${s}`)}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </FormField>
          ) : null}

          <FormField label={t('fields.reason')} htmlFor="cor-reason" required error={errors.reason?.message} hint={t('fields.reasonHint')}>
            <Textarea id="cor-reason" rows={3} {...register('reason')} aria-invalid={!!errors.reason} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{t('dialog.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
