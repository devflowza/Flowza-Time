import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Textarea } from '@/components/ui';

/**
 * Effective-dated changes (branch / department / designation / manager / type / status) close the current
 * employment_history row and open a new one from `effectiveFrom`. The dialog collects the date and a reason.
 */
export function EffectiveChangeDialog({ open, onOpenChange, changedFields, defaultDate, minDate, loading, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; changedFields: string[]; defaultDate: string; minDate?: string; loading?: boolean; onConfirm: (v: { effectiveFrom: string; changeReason?: string }) => void;
}) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const [effectiveFrom, setEffectiveFrom] = useState(defaultDate);
  const [reason, setReason] = useState('');
  const invalid = !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || (minDate ? effectiveFrom < minDate : false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('effective.title')}</DialogTitle>
          <DialogDescription>{t('effective.hint')}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {changedFields.map((f) => <li key={f} className="rounded-full bg-muted px-2 py-0.5">{t(`fields.${f}`)}</li>)}
        </ul>
        <FormField label={t('effective.effectiveFrom')} htmlFor="eff-date" required error={invalid ? t('effective.dateInvalid', { min: minDate ?? '' }) : undefined}>
          <Input id="eff-date" type="date" dir="ltr" value={effectiveFrom} min={minDate} onChange={(e) => setEffectiveFrom(e.target.value)} aria-invalid={invalid} />
        </FormField>
        <FormField label={t('effective.reason')} htmlFor="eff-reason" optional>
          <Textarea id="eff-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={t('effective.reasonPlaceholder')} />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" loading={loading} disabled={invalid} onClick={() => onConfirm({ effectiveFrom, changeReason: reason.trim() || undefined })}>{t('effective.apply')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
