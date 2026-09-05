import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Archive } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, FormField, Input, Textarea } from '@/components/ui';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeMutations, type EmployeeDetail } from '../../api';

export function DangerZone({ employee }: { employee: EmployeeDetail }) {
  const { t } = useTranslation('employees');
  const navigate = useNavigate();
  const can = useCan();
  const tz = useOrgTimezone();
  const { remove } = useEmployeeMutations();
  const [open, setOpen] = useState(false);
  const [exitDate, setExitDate] = useState(() => todayIso(tz));
  const [reason, setReason] = useState('');
  const allowed = can('employee.delete', 'employee.update');
  const archived = !!employee.deletedAt;
  return (
    <Card className="border-destructive/40">
      <CardHeader><CardTitle className="text-destructive">{t('danger.title')}</CardTitle><CardDescription>{t('danger.hint')}</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm"><p className="font-medium">{t('danger.archive')}</p><p className="text-muted-foreground">{t('danger.archiveHint')}</p></div>
        <Button variant="destructive" disabled={!allowed || archived} onClick={() => setOpen(true)}><Archive /> {archived ? t('danger.alreadyArchived') : t('danger.archive')}</Button>
      </CardContent>
      <ConfirmDialog open={open} onOpenChange={setOpen} title={t('danger.confirmTitle', { name: employee.displayName })} description={t('danger.confirmHint')} confirmLabel={t('danger.archive')} destructive loading={remove.isPending}
        onConfirm={() => remove.mutate({ id: employee.id, input: { exitDate: exitDate || undefined, reason: reason.trim() || undefined } }, { onSuccess: () => { toast.success(t('danger.archived')); navigate('/employees'); }, onError: toastError })}>
        <div className="space-y-3">
          <FormField label={t('fields.exitDate')} htmlFor="dz-exit" required><Input id="dz-exit" type="date" dir="ltr" value={exitDate} min={employee.joiningDate} onChange={(e) => setExitDate(e.target.value)} /></FormField>
          <FormField label={t('effective.reason')} htmlFor="dz-reason" optional><Textarea id="dz-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></FormField>
        </div>
      </ConfirmDialog>
    </Card>
  );
}
