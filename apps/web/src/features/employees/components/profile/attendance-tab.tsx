import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowRight } from 'lucide-react';
import type { AttendanceDailyRecordDto } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { api, ApiError, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { fmtDate, fmtMinutes, fmtTime, todayIso } from '@/lib/format';
import { useOrgId, useOrgTimezone } from '@/features/me/use-me';

const STATUS_TONE: Record<string, 'success' | 'danger' | 'info' | 'neutral' | 'warning'> = { PRESENT: 'success', ABSENT: 'danger', LEAVE: 'info', HOLIDAY: 'neutral', WEEKLY_OFF: 'neutral', HALF_DAY: 'warning', MISSING_PUNCH: 'warning', PENDING: 'neutral', NOT_JOINED: 'neutral', EXITED: 'neutral' };

/**
 * Compact recent attendance. The attendance module owns `/attendance`; this tab reads the monthly endpoint when it is
 * deployed and otherwise only offers the deep link.
 */
export function AttendanceTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation('employees');
  const orgId = useOrgId();
  const tz = useOrgTimezone();
  const month = todayIso(tz).slice(0, 7);
  const q = useQuery({
    queryKey: [...qk.detail(orgId, 'employees', employeeId), 'attendance', month],
    queryFn: async () => { const r = await api.get<PageEnvelope<AttendanceDailyRecordDto>>(`/orgs/${orgId}/attendance/monthly`, { month, employeeId, pageSize: 31, sort: 'attendanceDate', order: 'desc' }); return Array.isArray(r.data) ? r.data.slice(0, 14) : []; },
    retry: false,
  });
  const unavailable = q.isError && q.error instanceof ApiError && q.error.status === 404;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div><CardTitle>{t('attendance.recent')}</CardTitle><CardDescription>{t('attendance.recentHint', { month: fmtDate(`${month}-01`, 'MMMM yyyy') })}</CardDescription></div>
        <Button asChild variant="outline" size="sm"><Link to={`/attendance?employeeId=${employeeId}`}>{t('attendance.openFull')} <ArrowRight className="rtl:rotate-180" /></Link></Button>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
          : unavailable || (q.isError) ? <EmptyState icon={Activity} title={t('attendance.unavailable')} description={t('attendance.unavailableHint')} />
          : !q.data || q.data.length === 0 ? <EmptyState icon={Activity} title={t('attendance.empty')} description={t('attendance.emptyHint')} />
          : (
            <Table>
              <TableHeader><TableRow><TableHead>{t('attendance.date')}</TableHead><TableHead>{t('attendance.status')}</TableHead><TableHead>{t('attendance.in')}</TableHead><TableHead>{t('attendance.out')}</TableHead><TableHead>{t('attendance.worked')}</TableHead><TableHead>{t('attendance.flags')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {q.data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="tnum">{fmtDate(r.attendanceDate)}</TableCell>
                    <TableCell><Badge variant={STATUS_TONE[r.status] ?? 'neutral'} dot>{r.status}</Badge></TableCell>
                    <TableCell className="tnum">{fmtTime(r.firstInAt, r.timezone || tz)}</TableCell>
                    <TableCell className="tnum">{fmtTime(r.lastOutAt, r.timezone || tz)}</TableCell>
                    <TableCell className="tnum">{fmtMinutes(r.workedMinutes)}</TableCell>
                    <TableCell><span className="flex flex-wrap gap-1">{r.flags.map((f) => <Badge key={f} variant="outline" className="text-[10px]">{f}</Badge>)}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </CardContent>
    </Card>
  );
}
