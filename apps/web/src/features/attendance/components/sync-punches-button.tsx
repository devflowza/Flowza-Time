import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui';
import { todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useActiveMembership, useOrgTimezone } from '@/features/me/use-me';
import { toastJobQueued } from '@/features/employees/job-toast';
import '../workspace-i18n';
import { useAttendanceMutations, useInvalidateAttendance } from '../api';
import { toastMutationError } from '../period-locked';
import { syncRangeOf } from '../workspace-utils';

/**
 * "Sync punches" (HR portal Prompt 6a): recompute the days the register is showing — the current tab's date range and its
 * branch / department / employee filter — from the punches already received. Devices keep pushing and polling on their own
 * schedule; this re-reads what arrived. It queues a RECALCULATE_RANGE job (a queue job, so the toast points at the
 * Recalculations tab, never at /sync/:id).
 */
export function SyncPunchesButton() {
  const { t } = useTranslation('attendanceWorkspace');
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const membership = useActiveMembership();
  const { recalculate } = useAttendanceMutations();
  const invalidate = useInvalidateAttendance();
  const run = () => {
    const today = todayIso(tz);
    const range = syncRangeOf(params, today);
    if (range.fromDate > today) { toast.warning(t('sync.future')); return; }
    const branchId = params.get('branchId') || undefined;
    const departmentId = params.get('departmentId') || undefined;
    const employeeId = params.get('tab') !== 'daily' ? params.get('employeeId') || undefined : undefined;
    // a branch-scoped member must name a branch or employees (the API refuses an organisation-wide recompute for them)
    if (membership && !membership.allBranches && !branchId && !employeeId) { toast.warning(t('sync.pickBranch')); return; }
    recalculate.mutate(
      { ...range, branchId, departmentId, employeeIds: employeeId ? [employeeId] : undefined, reason: t('sync.reason') },
      {
        onSuccess: (res) => { toastJobQueued(res.jobId, navigate, t('sync.queued'), { to: `/attendance?tab=recalc&request=${res.requestId}`, actionLabel: t('sync.follow') }); invalidate(); },
        onError: (e) => toastMutationError(e, navigate),
      },
    );
  };
  return <Button variant="outline" size="sm" onClick={run} loading={recalculate.isPending} title={t('sync.hint')}><RefreshCcw /> {t('sync.button')}</Button>;
}
