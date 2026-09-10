import { useTranslation } from 'react-i18next';
import type { AttendanceActivityDto } from '@flowza/contracts';
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtDate, fmtMinutes, fmtTime } from '@/lib/format';
import { STATUS_TONE } from './activity-status';

/** Day-by-day (or month-by-month, for the year range) numbers behind the chart, with the period total as the last row. */
export function ActivityDetails({ data }: { data: AttendanceActivityDto }) {
  const { t } = useTranslation('employees');
  const tz = data.timezone;
  const byMonth = data.range === 'year';
  const dash = <span className="text-muted-foreground">—</span>;

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
          <TableCell className="text-end tnum">{fmtMinutes(data.totals.overtimeMinutes)}</TableCell>
          <TableCell className="text-end tnum">{byMonth ? t('activity.table.lateDays', { count: data.totals.lateDays }) : fmtMinutes(data.totals.lateMinutes)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
