import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { branchDeploymentInputSchema } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useEmployeeOptions } from '@/features/employees/api';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useDeploymentMutations } from '../api';
import { SCHED_NS } from '../i18n';

/**
 * Send an employee to another branch for a while: employee, host branch, inclusive range, reason, and whether to enrol them on
 * the host branch's terminals. The enrolment is a SYNC job: the toast's "View" opens /sync/<enrolJobId>.
 */
export function DeploymentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation(SCHED_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const employees = useEmployeeOptions();
  const branches = useBranchOptions();
  const { create } = useDeploymentMutations();
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(() => todayIso(tz));
  const [toDate, setToDate] = useState(() => todayIso(tz));
  const [reason, setReason] = useState('');
  const [enrolOnDevices, setEnrolOnDevices] = useState(true);
  const parsed = branchDeploymentInputSchema.safeParse({ employeeId, branchId, fromDate, toDate, reason, enrolOnDevices });
  const issue = (path: string) => (parsed.success ? undefined : parsed.error.issues.find((i) => i.path[0] === path));

  const onSave = () => {
    if (!parsed.success) return;
    create.mutate(parsed.data, {
      onSuccess: (d) => {
        if (d.enrolJobId) toastJobQueued(d.enrolJobId, navigate, t('deployments.enrolQueued', { branch: d.branchName ?? '' }));
        else toast.success(t('deployments.created'));
        onOpenChange(false);
      },
      onError: toastError,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('deployments.add')}</DialogTitle><DialogDescription>{t('deployments.dialogHint')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <FormField label={t('deployments.employee')} htmlFor="dep-employee" required>
            <Combobox id="dep-employee" value={employeeId} onChange={setEmployeeId} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('deployments.employee')} />
          </FormField>
          <FormField label={t('deployments.hostBranch')} htmlFor="dep-branch" required hint={t('deployments.hostBranchHint')}>
            <Combobox id="dep-branch" value={branchId} onChange={setBranchId} options={branches.options} loading={branches.isLoading} placeholder={t('deployments.hostBranch')} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('deployments.from')} htmlFor="dep-from" required><Input id="dep-from" type="date" dir="ltr" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></FormField>
            <FormField label={t('deployments.to')} htmlFor="dep-to" required error={toDate && fromDate && toDate < fromDate ? t('deployments.toBeforeFrom') : undefined} hint={t('deployments.toHint')}>
              <Input id="dep-to" type="date" dir="ltr" min={fromDate} value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </FormField>
          </div>
          <FormField label={t('deployments.reason')} htmlFor="dep-reason" required error={reason && issue('reason') ? t('deployments.reasonLength') : undefined}>
            <Input id="dep-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <div className="flex items-start gap-2">
            <Checkbox id="dep-enrol" checked={enrolOnDevices} onCheckedChange={(v) => setEnrolOnDevices(v === true)} />
            <div><Label htmlFor="dep-enrol">{t('deployments.enrol')}</Label><p className="text-xs text-muted-foreground">{t('deployments.enrolHint')}</p></div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={onSave} disabled={!parsed.success} loading={create.isPending} data-testid="deployment-save">{t('deployments.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
