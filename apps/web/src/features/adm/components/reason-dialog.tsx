import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Textarea } from '@/components/ui';

/**
 * Every platform change of a tenant's modules, plan or money is audited with a reason (the tenant reads it in its own audit
 * log): one small dialog asks for it before the action runs.
 */
export function ReasonDialog({ open, onOpenChange, title, description, confirmLabel, destructive, loading, defaultReason = '', onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: React.ReactNode; confirmLabel: string; destructive?: boolean; loading?: boolean;
  defaultReason?: string; onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const [reason, setReason] = useState(defaultReason);
  const valid = reason.trim().length >= 3;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle>{description ? <DialogDescription>{description}</DialogDescription> : null}</DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) onConfirm(reason.trim()); }} noValidate>
          <FormField label={t('reason.label')} htmlFor="reason-text" required hint={t('reason.hint')}>
            <Textarea id="reason-text" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={!valid} loading={loading}>{confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
