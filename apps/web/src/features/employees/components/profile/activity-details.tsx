import { useTranslation } from 'react-i18next';
import type { AttendanceActivityDto, AttendanceAwayFiguresDto } from '@flowza/contracts';
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtDate, fmtMinutes, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { STATUS_TONE } from './activity-status';
import { hasAwayData } from './away-model';

/**
 * Day-by-day (or month-by-month, for the year range) numbers behind the chart, with the period total as the last row. When the
 * policy measures time away, a column gives each row's away time and the unapproved part of it.
 */
export function ActivityDetails({ data }: { data: AttendanceActivityDto }) {
  const { t } = useTranslation('employees');
  const tz = data.timezone;
  const byMonth = data.range === 'year';
  const away = hasAwayData(data);
  const dash = <span className="text-muted-foreground">—</span>;
  const awayCell = (a: AttendanceAwayFiguresDto | undefined, strong = false) => (
    <TableCell className={cn('text-end tnum', strong && 'font-medium')}>
      {a && a.awayMinutes > 0 ? <>{fmtMinutes(a.awayMinutes)}{a.unapprovedAwayMinutes > 0 ? <span className="block text-xs font-normal text-destructive">{t('activity.away.unapprovedPart', { time: fmtMinutes(a.unapprovedAwayMinutes) })}</span> : null}</> : dash}
    </TableCell>
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t(byMonth ? 'activity.table.month' : 'activity.table.date')}</TableHead>
          {byMonth ? <TableHead className="text-end">{t('activity.table.days')}</TableHead> : <TableHead>{t('activity.table.status')}</TableHead>}
          {byMonth ? null : <TableHead>{t('activity.table.firstIn')}</TableHead>}
          {byMonth ? null : <TableHead>{t('activity.table.lastOut')}</TableHead>}
          <TableHead className="text-end">{t('activity.table.office')}</TableHead>
          <TableHead className="text-end">{t('activity.table.field')}</TableHead>
          {away ? <TableHead className="text-end">{t('activity.away.column')}</TableHead> : null}
          <TableHead className="text-end">{t('activity.table.overtime')}</TableHead>
          <TableHead className="text-end">{t('activity.table.late')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {byMonth
          ? data.months.map((m) => (
            <TableRow key={m.month}>
              <TableCell className="tnum">{fmtDate(`${m.month}-01`, 'MMMM yyyy')}</TableCell>
              <TableCell className="text-end tnum">{t('activity.table.presentOf', { present: m.presentDays, total: m.recordedDays })}</TableCell>
              <TableCell className="text-end tnum font-medium">{fmtMinutes(m.officeMinutes)}</TableCell>
              <TableCell className="text-end tnum">{m.fieldMinutes > 0 ? fmtMinutes(m.fieldMinutes) : dash}</TableCell>
              {away ? awayCell(m.away) : null}
              <TableCell className="text-end tnum">{m.overtimeMinutes > 0 ? fmtMinutes(m.overtimeMinutes) : dash}</TableCell>
              <TableCell className="text-end tnum">{m.lateDays > 0 ? t('activity.table.lateDays', { count: m.lateDays }) : dash}</TableCell>
            </TableRow>
          ))
          : data.days.map((d) => (
            <TableRow key={d.recordId}>
              <TableCell className="tnum">{fmtDate(d.date, 'EEE dd MMM')}</TableCell>
              <TableCell><Badge variant={STATUS_TONE[d.status] ?? 'neutral'} dot>{t(`activity.status.${d.status}`, { defaultValue: d.status })}</Badge></TableCell>
              <TableCell className="tnum" dir="ltr">{d.firstInAt ? fmtTime(d.firstInAt, tz) : dash}</TableCell>
              <TableCell className="tnum" dir="ltr">{d.lastOutAt ? fmtTime(d.lastOutAt, tz) : dash}</TableCell>
              <TableCell className="text-end tnum font-medium">{fmtMinutes(d.officeMinutes)}</TableCell>
              <TableCell className="text-end tnum">{d.fieldMinutes > 0 ? fmtMinutes(d.fieldMinutes) : dash}</TableCell>
              {away ? awayCell(d.away) : null}
              <TableCell className="text-end tnum">{d.overtimeMinutes > 0 ? fmtMinutes(d.overtimeMinutes) : dash}</TableCell>
              <TableCell className="text-end tnum">{d.lateMinutes > 0 ? fmtMinutes(d.lateMinutes) : dash}</TableCell>
            </TableRow>
          ))}
        <TableRow className="border-t-2 font-medium">
          <TableCell>{t('activity.table.total')}</TableCell>
          <TableCell className={byMonth ? 'text-end tnum' : undefined}>{byMonth ? t('activity.table.presentOf', { present: data.totals.presentDays, total: data.totals.recordedDays }) : null}</TableCell>
          {byMonth ? null : <TableCell />}
          {byMonth ? null : <TableCell />}
          <TableCell className="text-end tnum">{fmtMinutes(data.totals.officeMinutes)}</TableCell>
          <TableCell className="text-end tnum">{fmtMinutes(data.totals.fieldMinutes)}</TableCell>
          {away ? awayCell(data.totals.away, true) : null}
          <TableCell className="text-end tnum">{fmtMinutes(data.totals.overtimeMinutes)}</TableCell>
          <TableCell className="text-end tnum">{byMonth ? t('activity.table.lateDays', { count: data.totals.lateDays }) : fmtMinutes(data.totals.lateMinutes)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
