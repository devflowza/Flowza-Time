import { useTranslation } from 'react-i18next';
import { Camera } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Skeleton, Switch } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useActiveMembership, useCan, useOrgTimezone } from '@/features/me/use-me';
import { AR_NS } from '../i18n';
import { useAttendanceGrants, usePutAttendanceGrants } from '../api';

/**
 * Per-employee portal attendance switches on the employee profile (HR portal Prompt 4): open attendance (the employee may
 * check in anywhere with a selfie that a manager reviews) and "selfie required" (every portal punch needs one). Managed by
 * the employee's line manager or an attendance approver; the card renders nothing for anyone else (the API refuses them).
 */
export function AttendanceGrantsCard({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation(AR_NS);
  const can = useCan();
  const tz = useOrgTimezone();
  const membership = useActiveMembership();
  const mayManage = can('attendance.approve') || (membership?.isManager ?? false);
  const q = useAttendanceGrants(employeeId, mayManage);
  const put = usePutAttendanceGrants(employeeId);
  if (!mayManage || q.isError) return null;
  const g = q.data;
  const save = (patch: { openAttendance?: boolean; selfieRequired?: boolean }) => {
    if (!g) return;
    put.mutate({ openAttendance: patch.openAttendance ?? g.openAttendance, selfieRequired: patch.selfieRequired ?? g.selfieRequired }, { onSuccess: () => toast.success(t('grants.saved')), onError: toastError });
  };
  return (
    <Card className="mt-4" data-testid="attendance-grants">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Camera className="size-4" aria-hidden />{t('grants.title')}</CardTitle>
        <CardDescription>{t('grants.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!g ? <Skeleton className="h-16 w-full" /> : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div><Label htmlFor={`grant-open-${employeeId}`}>{t('grants.openAttendance')}</Label><p className="text-xs text-muted-foreground">{t('grants.openAttendanceHint')}</p></div>
              <Switch id={`grant-open-${employeeId}`} checked={g.openAttendance} disabled={put.isPending} onCheckedChange={(v) => save({ openAttendance: v })} />
            </div>
            <div className="flex items-start justify-between gap-4">
              <div><Label htmlFor={`grant-selfie-${employeeId}`}>{t('grants.selfieRequired')}</Label><p className="text-xs text-muted-foreground">{t('grants.selfieRequiredHint')}</p></div>
              <Switch id={`grant-selfie-${employeeId}`} checked={g.selfieRequired} disabled={put.isPending} onCheckedChange={(v) => save({ selfieRequired: v })} />
            </div>
            {g.grantedByName && g.grantedAt ? <p className="text-xs text-muted-foreground">{t('grants.changedBy', { name: g.grantedByName, date: fmtDateTime(g.grantedAt, tz) })}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
