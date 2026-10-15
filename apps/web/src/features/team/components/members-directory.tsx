import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { UsersRound } from 'lucide-react';
import type { EmployeeDto } from '@flowza/contracts';
import { Badge, Card, EmptyState, ErrorState, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { useCan, useEmployeeId } from '@/features/me/use-me';
import { useEmployees } from '@/features/employees/api';
import { EmploymentStatusBadge } from '@/features/employees/components/employee-badges';
import { TEAM_NS } from '../i18n';

/**
 * How a report reaches the caller: as their manager, their secondary manager, or further down the reporting line (an
 * organisation whose team scope is the whole hierarchy) — then through the report's own manager: the primary one, or the
 * secondary one the reporting line walks through when the report has no primary manager (app._team_of).
 */
function RelationBadge({ e, employeeId }: { e: EmployeeDto; employeeId: string | null }) {
  const { t } = useTranslation(TEAM_NS);
  if (e.managerEmployeeId === employeeId) return <Badge variant="info">{t('relation.primary')}</Badge>;
  // an API that does not send the secondary manager lists direct reports only: anyone else is a secondary report
  if (e.secondaryManagerEmployeeId === undefined || e.secondaryManagerEmployeeId === employeeId) return <Badge variant="neutral">{t('relation.secondary')}</Badge>;
  const via = e.managerEmployeeId ? e.managerName : e.secondaryManagerName;
  return <Badge variant="neutral" dir="auto">{via ? t('relation.indirectVia', { managerName: via }) : t('relation.indirect')}</Badge>;
}

/**
 * The team as a directory (employee.view_team, or the organisation-wide employee.view): what the Today tab shows to a manager
 * whose role cannot read the team's attendance. `teamOf` = the caller's own employee follows the organisation's team scope
 * (the direct reports, or the reporting line under 'hierarchy' — the header's count). Without either key the list stays
 * hidden and says why.
 */
export function MembersDirectory() {
  const { t } = useTranslation(TEAM_NS);
  const { t: te } = useTranslation('employees');
  const can = useCan();
  const employeeId = useEmployeeId();
  const canList = (can('employee.view_team') || can('employee.view')) && !!employeeId;
  const q = useEmployees({ teamOf: employeeId ?? undefined, pageSize: 100, sort: 'displayName' }, canList);
  return (
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
                  <TableCell><RelationBadge e={e} employeeId={employeeId} /></TableCell>
                  <TableCell><EmploymentStatusBadge status={e.employmentStatus} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
    </Card>
  );
}
