import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Avatar, Badge, Button, ErrorState, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useEmployee, useEmployeeMutations } from '../api';
import { EmploymentStatusBadge } from '../components/employee-badges';
import { OverviewTab } from '../components/profile/overview-tab';
import { HistoryTab } from '../components/profile/history-tab';
import { DevicesTab } from '../components/profile/devices-tab';
import { AttendanceTab } from '../components/profile/attendance-tab';
import { DocumentsTab } from '../components/profile/documents-tab';
import { DangerZone } from '../components/profile/danger-zone';
import { toastJobQueued } from '../job-toast';

const TABS = ['overview', 'history', 'devices', 'attendance', 'documents', 'danger'] as const;
type Tab = (typeof TABS)[number];

export default function EmployeeProfilePage() {
  const { t } = useTranslation('employees');
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';
  const q = useEmployee(id);
  const { bulk } = useEmployeeMutations();
  const e = q.data;
  const tabs = TABS.filter((tb) => (tb === 'documents' ? can('employee.view_sensitive') : tb === 'danger' ? can('employee.delete') : true));

  return (
    <div className="page-container">
      {q.isLoading ? <div className="space-y-4"><Skeleton className="h-8 w-72" /><Skeleton className="h-10 w-96" /><Skeleton className="h-96 w-full" /></div>
        : q.isError || !e ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <>
            <PageHeader
              breadcrumbs={<Link to="/employees" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('title')}</Link>}
              title={e.displayName}
              description={[e.employeeNumber, e.designationName, e.departmentName, e.branchName].filter(Boolean).join(' · ')}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <EmploymentStatusBadge status={e.employmentStatus} />
                  {e.deletedAt ? <Badge variant="neutral">{t('profile.archived')}</Badge> : null}
                  <Badge variant="outline" className="font-mono" dir="ltr">ID {e.deviceUserId}</Badge>
                  <span className="text-xs text-muted-foreground tnum">{t('profile.joined', { date: fmtDate(e.joiningDate) })}</span>
                  {can('device.sync') && !e.deletedAt ? <Button size="sm" variant="outline" loading={bulk.isPending} onClick={() => bulk.mutate({ action: 'sync_devices', employeeIds: [e.id] }, { onSuccess: (r) => { if (r.kind === 'job') toastJobQueued(r.jobId, navigate); }, onError: toastError })}><RefreshCw /> {t('devices.syncNow')}</Button> : null}
                </div>
              }
            />
            <div className="mb-4 flex items-center gap-3">
              <Avatar name={e.displayName} src={e.photoUrl} className="size-12 text-base" />
              <div className="text-sm text-muted-foreground"><p dir="ltr">{e.email ?? '—'}</p><p dir="ltr">{e.phone ?? '—'}</p></div>
            </div>
            <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
              <TabsList className="max-w-full overflow-x-auto">{tabs.map((tb) => <TabsTrigger key={tb} value={tb} className={tb === 'danger' ? 'data-[state=active]:text-destructive' : undefined}>{t(`profile.tabs.${tb}`)}</TabsTrigger>)}</TabsList>
              <TabsContent value="overview"><OverviewTab key={e.updatedAt} employee={e} /></TabsContent>
              <TabsContent value="history">{tab === 'history' ? <HistoryTab employeeId={e.id} /> : null}</TabsContent>
              <TabsContent value="devices">{tab === 'devices' ? <DevicesTab employeeId={e.id} /> : null}</TabsContent>
              <TabsContent value="attendance">{tab === 'attendance' ? <AttendanceTab employeeId={e.id} /> : null}</TabsContent>
              <TabsContent value="documents">{tab === 'documents' ? <DocumentsTab employeeId={e.id} /> : null}</TabsContent>
              <TabsContent value="danger">{tab === 'danger' ? <DangerZone employee={e} /> : null}</TabsContent>
            </Tabs>
          </>
        )}
    </div>
  );
}
