import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { REGULARISATION_TYPES, type RegularisationType } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { toast } from '@/lib/toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { localToUtcIso } from '@/features/corrections/time';
import { PA_NS } from '../attendance-i18n';
import { useRegularisationMutations } from '../attendance-api';

const NEEDS_TIMES: ReadonlySet<RegularisationType> = new Set(['missed_punch', 'wrong_punch']);

/**
 * Ask for a regularisation of one of the employee's own days: a missed or wrong punch (with the right times), a
 * work-from-home day that was not marked, or a terminal / system outage. Times are entered in the day's own timezone and
 * sent as UTC; nothing changes until the request is approved (it is then applied as a correction).
 */
export function RegularisationDialog({ open, onOpenChange, date, timezone, maxDate }: { open: boolean; onOpenChange: (o: boolean) => void; date?: string | null; timezone: string; maxDate?: string }) {
  const { t } = useTranslation(PA_NS);
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const { create } = useRegularisationMutations();
  const [day, setDay] = useState(date ?? '');
  const [type, setType] = useState<RegularisationType>('missed_punch');
  const [inTime, setInTime] = useState('');
  const [outTime, setOutTime] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const needsTimes = NEEDS_TIMES.has(type);
  // times are optional for WFH / downtime (they become punches when given; the day is marked present either way)
  const proposedInAt = localToUtcIso(day, inTime, timezone);
  // an out time before the in time on the same date means the shift ran past midnight: the check-out is the next day
  let proposedOutAt = localToUtcIso(day, outTime, timezone);
  if (proposedInAt && proposedOutAt && Date.parse(proposedOutAt) <= Date.parse(proposedInAt)) proposedOutAt = new Date(Date.parse(proposedOutAt) + 86_400_000).toISOString();
  const errors = {
    day: !day ? t('regularisation.dayRequired') : undefined,
    times: needsTimes && !proposedInAt && !proposedOutAt ? t('regularisation.timesRequired') : undefined,
    reason: reason.trim().length < 3 ? t('regularisation.reasonTooShort') : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  const submit = () => {
    setTouched(true);
    if (invalid) return;
    create.mutate({ date: day, type, reason: reason.trim(), ...(proposedInAt ? { proposedInAt } : {}), ...(proposedOutAt ? { proposedOutAt } : {}) }, {
      onSuccess: () => { toast.success(t('regularisation.submitted')); onOpenChange(false); },
      onError: (e) => toastMutationError(e, (to) => void navigate(to)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('regularisation.title')}</DialogTitle><DialogDescription>{t('regularisation.hint')}</DialogDescription></DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('regularisation.date')} htmlFor="reg-date" required error={touched ? errors.day : undefined}>
              <Input id="reg-date" type="date" value={day} max={maxDate} onChange={(e) => setDay(e.target.value)} className="tnum" />
            </FormField>
            <FormField label={t('regularisation.type')} htmlFor="reg-type" required>
              <Select value={type} onValueChange={(v) => setType(v as RegularisationType)}>
                <SelectTrigger id="reg-type"><SelectValue /></SelectTrigger>
                <SelectContent>{REGULARISATION_TYPES.map((r) => <SelectItem key={r} value={r}>{t(`regularisation.types.${r}`)}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('regularisation.in', { zone: timezone })} htmlFor="reg-in" optional={!needsTimes} error={touched ? errors.times : undefined}>
                <Input id="reg-in" type="time" step={60} dir="ltr" className="tnum" value={inTime} onChange={(e) => setInTime(e.target.value)} />
              </FormField>
              <FormField label={t('regularisation.out', { zone: timezone })} htmlFor="reg-out" optional>
                <Input id="reg-out" type="time" step={60} dir="ltr" className="tnum" value={outTime} onChange={(e) => setOutTime(e.target.value)} />
              </FormField>
          </div>
          {!needsTimes ? <p className="-mt-2 text-xs text-muted-foreground">{t('regularisation.presentHint')}</p> : null}
          <FormField label={t('regularisation.reason')} htmlFor="reg-reason" required hint={t('regularisation.reasonHint')} error={touched ? errors.reason : undefined}>
            <Textarea id="reg-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending}>{t('regularisation.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
