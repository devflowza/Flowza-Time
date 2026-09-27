import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, ContactRound, UsersRound } from 'lucide-react';
import type { EmployeeDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Card, EmptyState, ErrorState, Skeleton, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { useActiveMembership, useCan, useEmployeeId } from '@/features/me/use-me';
import { useEmployees } from '@/features/employees/api';
import { EmploymentStatusBadge } from '@/features/employees/components/employee-badges';

/** /team — the line manager's home: who reports to me (primary or secondary), with the team queue arriving in a later release. */
export default function TeamPage() {
  const { t } = useTranslation('team');
  const { t: tc } = useTranslation();
  const { t: te } = useTranslation('employees');
  const membership = useActiveMembership();
  const employeeId = useEmployeeId();
  const can = useCan();
  const isManager = membership?.isManager ?? false;
  // the list needs employee.view_team (own record + direct reports) or the organisation-wide employee.view; a manager
  // whose role holds neither still sees the team size from /me
  const canList = isManager && (can('employee.view_team') || can('employee.view')) && !!employeeId;
  const q = useEmployees({ teamOf: employeeId ?? undefined, pageSize: 100, sort: 'displayName' }, canList);
  const teamSize = membership?.teamSize ?? 0;

  if (!isManager) {
    return <div className="page-container"><EmptyState icon={UsersRound} title={t('notManager')} description={t('notManagerHint')} action={<Link to="/" className="text-sm font-medium text-primary hover:underline">{tc('nav.dashboard')}</Link>} /></div>;
  }

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('title')} description={t('subtitle', { count: teamSize })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label={t('directReports')} value={teamSize} icon={ContactRound} hint={t('directReportsHint')} />
        <Card className="flex items-start gap-3 p-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-brand-700"><CalendarCheck className="size-5" aria-hidden /></div>
          <div className="min-w-0"><p className="text-sm font-medium">{t('comingSoon')}</p><p className="mt-0.5 text-xs text-muted-foreground">{t('comingSoonHint')}</p></div>
        </Card>
      </div>
      <Card>
        <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2"><h2 className="text-sm font-semibold">{t('members')}</h2></div>
        {!canList ? <p className="px-5 pb-5 text-sm text-muted-foreground">{t('noDirectory')}</p>
          : q.isLoading ? <div className="space-y-2 px-5 pb-5"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
          : q.isError ? <div className="px-5 pb-5"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : (q.data?.data.length ?? 0) === 0 ? <div className="px-5 pb-5"><EmptyState icon={UsersRound} title={t('empty')} description={t('emptyHint')} /></div>
          : (
            <Table>
              <TableHeader><TableRow><TableHead>{t('columns.name')}</TableHead><TableHead>{t('columns.designation')}</TableHead><TableHead>{t('columns.department')}</TableHead><TableHead>{t('columns.branch')}</TableHead><TableHead>{t('columns.relation')}</TableHead><TableHead>{te('fields.employmentStatus')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {(q.data?.data ?? []).map((e: EmployeeDto) => (
                  <TableRow key={e.id}>
                    <TableCell><Link to={`/employees/${e.id}`} className="font-medium hover:underline">{e.displayName}</Link><p className="font-mono text-xs text-muted-foreground" dir="ltr">{e.employeeNumber}</p></TableCell>
                    <TableCell>{e.designationName ?? '—'}</TableCell>
                    <TableCell>{e.departmentName ?? '—'}</TableCell>
                    <TableCell>{e.branchName ?? '—'}</TableCell>
                    <TableCell><Badge variant={e.managerEmployeeId === employeeId ? 'info' : 'neutral'}>{e.managerEmployeeId === employeeId ? t('relation.primary') : t('relation.secondary')}</Badge></TableCell>
                    <TableCell><EmploymentStatusBadge status={e.employmentStatus} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Card>
    </div>
  );
}
