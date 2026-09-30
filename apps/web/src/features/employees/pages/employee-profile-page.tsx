import { Suspense, lazy } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Avatar, Badge, Button, ErrorState, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useCan, useEmployeeId, useModuleEnabled } from '@/features/me/use-me';
import { useEmployee, useEmployeeMutations } from '../api';
import { EmploymentStatusBadge } from '../components/employee-badges';
import { OverviewTab } from '../components/profile/overview-tab';
import { HistoryTab } from '../components/profile/history-tab';
import { DevicesTab } from '../components/profile/devices-tab';
import { AttendanceTab } from '../components/profile/attendance-tab';
import { DocumentsTab } from '../components/profile/documents-tab';
import { DangerZone } from '../components/profile/danger-zone';
import { toastJobQueued } from '../job-toast';
import { AttendanceGrantsCard } from '@/features/attendance-review/components/attendance-grants-card';
import { PortalAccessCard } from '@/features/users/components/portal-access-card';

// The activity view is the only part of the profile that charts, and Recharts is a 118 kB (gzipped) vendor chunk:
// loading it lazily keeps it off every other visit to a profile.
const ActivityTab = lazy(() => import('../components/profile/activity-tab').then((m) => ({ default: m.ActivityTab })));

const TABS = ['overview', 'history', 'devices', 'attendance', 'activity', 'documents', 'danger'] as const;
type Tab = (typeof TABS)[number];

export default function EmployeeProfilePage() {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const can = useCan();
  const ownEmployeeId = useEmployeeId();
  const [params, setParams] = useSearchParams();
  const q = useEmployee(id);
  const { bulk } = useEmployeeMutations();
  const e = q.data;
  const isOwn = !!e && e.id === ownEmployeeId;
  // the Devices & sync and self-service portal modules (migration 20260929000600)
  const devicesOn = useModuleEnabled('devices');
  const selfServiceOn = useModuleEnabled('self_service');
  // A line manager (employee.view_team) opens a direct report's profile too. Tabs whose data sits behind other keys stay
  // hidden instead of rendering an empty list — or, for attendance, the viewer's OWN month (the attendance API scopes an
  // attendance.view_own caller to their own record whatever employee is asked for). Own record: RLS self rows apply.
  const tabs = TABS.filter((tb) => {
    switch (tb) {
      case 'documents': return can('employee.view_sensitive');
      case 'danger': return can('employee.delete');
      case 'activity': return can('attendance.view');
      case 'history': return can('employee.view') || isOwn;
      case 'devices': return devicesOn && (can('device.view') || isOwn);
      case 'attendance': return can('attendance.view') || isOwn;
      default: return true;
    }
  });
  const requested = params.get('tab') ?? '';
  // a line manager has no directory to go back to: the breadcrumb leads to their team instead
  const directory = can('employee.view');
  // a hidden tab named in the URL falls back to the overview (the API would refuse or show nothing anyway)
  const tab: Tab = (tabs as readonly string[]).includes(requested) ? (requested as Tab) : 'overview';

  return (
    <div className="page-container">
      {q.isLoading ? <div className="space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-10 w-96" /><Skeleton className="h-96 w-full" /></div>
        : q.isError || !e ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <>
            <PageHeader
              breadcrumbs={<Link to={directory ? '/employees' : '/team'} className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {directory ? t('title') : tc('nav.sections.team')}</Link>}
              title={e.displayName}
              description={[e.employeeNumber, e.designationName, e.departmentName, e.branchName].filter(Boolean).join(' · ')}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <EmploymentStatusBadge status={e.employmentStatus} />
                  {e.deletedAt ? <Badge variant="neutral">{t('profile.archived')}</Badge> : null}
                  <Badge variant="outline" className="font-mono" dir="ltr">ID {e.deviceUserId}</Badge>
                  <span className="text-xs text-muted-foreground tnum">{t('profile.joined', { date: fmtDate(e.joiningDate) })}</span>
                  {can('device.sync') && devicesOn && !e.deletedAt ? <Button size="sm" variant="outline" loading={bulk.isPending} onClick={() => bulk.mutate({ action: 'sync_devices', employeeIds: [e.id] }, { onSuccess: (r) => { if (r.kind === 'job') toastJobQueued(r.jobId, navigate, undefined, { to: '/sync' }); }, onError: toastError })}><RefreshCw /> {t('devices.syncNow')}</Button> : null}
                </div>
              }
            />
            <div className="mb-4 flex items-center gap-3">
              <Avatar name={e.displayName} src={e.photoUrl} className="size-12 text-base" />
              <div className="text-sm text-muted-foreground">
                <p dir="ltr">{e.email ?? '—'}</p><p dir="ltr">{e.phone ?? '—'}</p>
                {/* Reporting line: the primary manager drives team visibility and approvals, the secondary is the dotted line / backup. */}
                <p data-testid="reports-to">
                  <span>{t('profile.reportsTo')}: </span>
                  {e.managerEmployeeId ? <Link to={`/employees/${e.managerEmployeeId}`} className="font-medium text-foreground hover:underline">{e.managerName ?? '—'}</Link> : <span>{t('profile.noManager')}</span>}
                  {e.secondaryManagerEmployeeId ? <> · <span>{t('profile.alsoReportsTo')} </span><Link to={`/employees/${e.secondaryManagerEmployeeId}`} className="font-medium text-foreground hover:underline">{e.secondaryManagerName ?? '—'}</Link></> : null}
                </p>
              </div>
            </div>
            <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
              <TabsList className="max-w-full overflow-x-auto">{tabs.map((tb) => <TabsTrigger key={tb} value={tb} className={tb === 'danger' ? 'data-[state=active]:text-destructive' : undefined}>{t(`profile.tabs.${tb}`)}</TabsTrigger>)}</TabsList>
              <TabsContent value="overview"><OverviewTab key={e.updatedAt} employee={e} />{!isOwn && !e.deletedAt ? <AttendanceGrantsCard employeeId={e.id} /> : null}{!isOwn && selfServiceOn ? <PortalAccessCard employeeId={e.id} employeeName={e.displayName} /> : null}</TabsContent>
              <TabsContent value="history">{tab === 'history' ? <HistoryTab employeeId={e.id} /> : null}</TabsContent>
              <TabsContent value="devices">{tab === 'devices' ? <DevicesTab employeeId={e.id} employee={{ name: e.displayName, number: e.employeeNumber, deviceUserId: e.deviceUserId }} /> : null}</TabsContent>
              <TabsContent value="attendance">{tab === 'attendance' ? <AttendanceTab employeeId={e.id} /> : null}</TabsContent>
              <TabsContent value="activity">{tab === 'activity' ? <Suspense fallback={<Skeleton className="h-96 w-full" />}><ActivityTab employeeId={e.id} /></Suspense> : null}</TabsContent>
              <TabsContent value="documents">{tab === 'documents' ? <DocumentsTab employeeId={e.id} /> : null}</TabsContent>
              <TabsContent value="danger">{tab === 'danger' ? <DangerZone employee={e} /> : null}</TabsContent>
            </Tabs>
          </>
        )}
    </div>
  );
}
