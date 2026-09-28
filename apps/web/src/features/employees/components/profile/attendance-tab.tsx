import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowRight, Printer } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { api, ApiError, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { fmtDate, fmtMinutes, todayIso } from '@/lib/format';
import { useOrgId, useOrgTimezone } from '@/features/me/use-me';
import type { MonthlyRow, MonthlyTotals } from '@/features/attendance/types';
import { fmtDays } from '@/features/attendance/status';
import '@/features/attendance/workspace-i18n';
import { recentDays } from './recent-days';
import { STATUS_TONE } from './activity-status';

/** Month summary strip (HR portal Prompt 6a): the monthly row's totals, so the tab needs no second request. */
function MonthStrip({ totals }: { totals: MonthlyTotals }) {
  const { t } = useTranslation('attendanceWorkspace');
  const items: Array<[string, string, string?]> = [
    ['present', fmtDays(totals.present), 'text-emerald-700 dark:text-emerald-300'], ['late', fmtDays(totals.late), 'text-amber-700 dark:text-amber-300'],
    ['half', fmtDays(totals.halfDay)], ['leave', fmtDays(totals.leave), 'text-blue-700 dark:text-blue-300'], ['absent', fmtDays(totals.absent), 'text-red-700 dark:text-red-300'],
    ['missing', fmtDays(totals.missingPunch)], ['worked', fmtMinutes(totals.workedMinutes)], ['overtime', fmtMinutes(totals.overtimeMinutes)],
  ];
  return (
    <dl className="mb-4 grid grid-cols-4 gap-2 rounded-md border bg-muted/30 p-3 text-xs sm:grid-cols-8" data-testid="attendance-month-strip">
      {items.map(([k, v, cls]) => <div key={k} className="min-w-0"><dt className="truncate text-muted-foreground">{t(`summary.columns.${k}`)}</dt><dd className={`text-sm font-semibold tnum ${cls ?? ''}`}>{v}</dd></div>)}
    </dl>
  );
}

/**
 * Compact recent attendance. The attendance module owns `/attendance`; this tab reads the monthly endpoint for the
 * current month (one row per employee with a per-day map — see `recentDays`) and otherwise only offers the deep link.
 */
export function AttendanceTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation('employees');
  const { t: tw } = useTranslation('attendanceWorkspace');
  const orgId = useOrgId();
  const tz = useOrgTimezone();
  const month = todayIso(tz).slice(0, 7);
  const q = useQuery({
    queryKey: [...qk.detail(orgId, 'employees', employeeId), 'attendance', month],
    queryFn: async () => {
      const r = await api.get<PageEnvelope<MonthlyRow>>(`/orgs/${orgId}/attendance/monthly`, { month, employeeId, pageSize: 1 });
      const rows = Array.isArray(r.data) ? r.data : [];
      const own = rows.find((x) => x.employeeId === employeeId);
      return { days: recentDays(rows, employeeId), totals: own?.totals ?? null };
    },
    retry: false,
  });
  const unavailable = q.isError && q.error instanceof ApiError && q.error.status === 404;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div><CardTitle>{t('attendance.recent')}</CardTitle><CardDescription>{t('attendance.recentHint', { month: fmtDate(`${month}-01`, 'MMMM yyyy') })}</CardDescription></div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="ghost" size="sm"><Link to={`/attendance/print?employeeId=${employeeId}&month=${month}`}><Printer /> {tw('print.open')}</Link></Button>
          <Button asChild variant="outline" size="sm"><Link to={`/attendance?employeeId=${employeeId}`}>{t('attendance.openFull')} <ArrowRight className="rtl:rotate-180" /></Link></Button>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
          : unavailable || (q.isError) ? <EmptyState icon={Activity} title={t('attendance.unavailable')} description={t('attendance.unavailableHint')} />
          : !q.data || q.data.days.length === 0 ? <EmptyState icon={Activity} title={t('attendance.empty')} description={t('attendance.emptyHint')} />
          : (
            <>
            {q.data.totals ? <MonthStrip totals={q.data.totals} /> : null}
            <Table>
              <TableHeader><TableRow><TableHead>{t('attendance.date')}</TableHead><TableHead>{t('attendance.status')}</TableHead><TableHead>{t('attendance.worked')}</TableHead><TableHead>{t('attendance.late')}</TableHead><TableHead>{t('attendance.overtime')}</TableHead><TableHead>{t('attendance.flags')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {q.data.days.map((r) => (
                  <TableRow key={r.recordId || r.date}>
                    <TableCell className="tnum">{fmtDate(r.date)}</TableCell>
                    <TableCell><Badge variant={STATUS_TONE[r.status] ?? 'neutral'} dot>{r.status}</Badge></TableCell>
                    <TableCell className="tnum">{fmtMinutes(r.workedMinutes)}</TableCell>
                    <TableCell className="tnum">{r.lateMinutes > 0 ? fmtMinutes(r.lateMinutes) : '—'}</TableCell>
                    <TableCell className="tnum">{r.overtimeMinutes > 0 ? fmtMinutes(r.overtimeMinutes) : '—'}</TableCell>
                    <TableCell><span className="flex flex-wrap gap-1">{r.flags.map((f) => <Badge key={f} variant="outline" className="text-[10px]">{f}</Badge>)}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </>
          )}
      </CardContent>
    </Card>
  );
}
