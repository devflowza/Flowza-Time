import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlarmClock, CalendarCheck, CalendarX2, ChevronLeft, ChevronRight, ClipboardList, Clock, Hourglass, TrendingUp, Undo2 } from 'lucide-react';
import type { SelfDayDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, Skeleton, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMinutes, fmtTime, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useActiveMembership, useEmployeeId, useOrgTimezone } from '@/features/me/use-me';
import { AttendanceStatusBadge, CorrectionStatusBadge, CorrectionTypeBadge, FlagChips } from '@/features/attendance/components/badges';
import { CorrectionSummary, RecordDialog } from '@/features/attendance/components/record-dialog';
import { useCorrectionMutations, useCorrections } from '@/features/corrections/api';
import type { CorrectionDto } from '@/features/attendance/types';
import { ActivityTab } from '@/features/employees/components/profile/activity-tab';
import { useSelfAttendance } from '../api';
import { fmtDays, shiftMonth, validMonth } from '../model';
import { MonthCalendar } from '../components/month-calendar';
import { SelfCorrectionDialog } from '../components/self-correction-dialog';

const TABS = ['calendar', 'log', 'activity', 'corrections'] as const;
type Tab = (typeof TABS)[number];

function DailyLog({ days, onSelect }: { days: SelfDayDto[]; onSelect: (d: SelfDayDto) => void }) {
  const { t } = useTranslation('portal');
  const rows = [...days].reverse();
  if (rows.length === 0) return <EmptyState icon={CalendarX2} title={t('attendance.emptyMonth')} description={t('attendance.emptyMonthHint')} />;
  return (
    <>
      <div className="hidden rounded-lg border bg-card shadow-card md:block">
        <Table>
          <TableHeader><TableRow>{(['date', 'status', 'shift', 'in', 'out', 'worked', 'late', 'overtime', 'flags'] as const).map((c) => <TableHead key={c}>{t(`attendance.columns.${c}`)}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => onSelect(r)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onSelect(r); }}>
                <TableCell className="whitespace-nowrap font-medium tnum">{fmtDate(r.attendanceDate, 'EEE dd MMM')}</TableCell>
                <TableCell><AttendanceStatusBadge status={r.status} /></TableCell>
                <TableCell className="text-xs">{r.shiftName ?? '—'}</TableCell>
                <TableCell className="text-xs tnum" dir="ltr">{fmtTime(r.firstInAt, r.timezone)}</TableCell>
                <TableCell className="text-xs tnum" dir="ltr">{fmtTime(r.lastOutAt, r.timezone)}</TableCell>
                <TableCell className="text-xs tnum">{fmtMinutes(r.workedMinutes)}</TableCell>
                <TableCell className="text-xs tnum">{r.lateMinutes ? fmtMinutes(r.lateMinutes) : '—'}</TableCell>
                <TableCell className="text-xs tnum">{r.overtimeMinutes ? fmtMinutes(r.overtimeMinutes) : '—'}</TableCell>
                <TableCell><FlagChips flags={r.flags} max={2} size="xs" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onSelect(r)} className="w-full rounded-lg border bg-card p-3 text-start shadow-card">
              <span className="flex items-center justify-between gap-2"><span className="font-medium tnum">{fmtDate(r.attendanceDate, 'EEE dd MMM')}</span><AttendanceStatusBadge status={r.status} /></span>
              <span className="mt-1 block text-xs text-muted-foreground tnum"><span dir="ltr">{fmtTime(r.firstInAt, r.timezone)} – {fmtTime(r.lastOutAt, r.timezone)}</span> · {fmtMinutes(r.workedMinutes)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function CorrectionsTab({ timezone }: { timezone: string }) {
  const { t } = useTranslation('portal');
  const q = useCorrections({ page: 1, pageSize: 100 });
  const { cancel } = useCorrectionMutations();
  const [withdrawing, setWithdrawing] = useState<CorrectionDto | null>(null);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <TableSkeleton cols={6} rows={3} />;
  const rows = q.data?.data ?? [];
  if (rows.length === 0) return <EmptyState icon={ClipboardList} title={t('attendance.corrections.empty')} description={t('attendance.corrections.emptyHint')} />;
  return (
    <div className="rounded-lg border bg-card shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>{(['date', 'type', 'change', 'reason', 'status', 'submitted'] as const).map((c) => <TableHead key={c}>{t(`attendance.corrections.${c}`)}</TableHead>)}<TableHead /></TableRow></TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="whitespace-nowrap font-medium tnum">{fmtDate(c.attendanceDate, 'EEE dd MMM')}</TableCell>
                <TableCell><CorrectionTypeBadge type={c.type} /></TableCell>
                <TableCell><CorrectionSummary c={c} timezone={timezone} /></TableCell>
                <TableCell className="max-w-[260px] text-xs"><span className="block truncate" title={c.reason}>{c.reason}</span>{c.status === 'REJECTED' && c.rejectionReason ? <span className="block truncate text-destructive" title={c.rejectionReason}>{t('attendance.corrections.rejectedBecause', { reason: c.rejectionReason })}</span> : null}</TableCell>
                <TableCell><CorrectionStatusBadge status={c.status} /></TableCell>
                <TableCell className="whitespace-nowrap text-xs tnum">{fmtDateTime(c.createdAt, timezone)}</TableCell>
                <TableCell className="text-end">{c.status === 'PENDING' ? <Button size="sm" variant="ghost" onClick={() => setWithdrawing(c)}><Undo2 /> {t('attendance.corrections.withdraw')}</Button> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog open={!!withdrawing} onOpenChange={(o) => !o && setWithdrawing(null)} title={t('attendance.corrections.withdrawTitle')} description={t('attendance.corrections.withdrawHint')} confirmLabel={t('attendance.corrections.withdraw')} destructive loading={cancel.isPending}
        onConfirm={() => { if (!withdrawing) return; cancel.mutate({ id: withdrawing.id }, { onSuccess: () => { toast.success(t('attendance.corrections.withdrawn')); setWithdrawing(null); }, onError: toastError }); }} />
    </div>
  );
}

/** /my/attendance?month=yyyy-MM&tab=calendar|log|activity|corrections&day=<record id> */
export default function MyAttendancePage() {
  const { t } = useTranslation('portal');
  const tz = useOrgTimezone();
  const employeeId = useEmployeeId();
  const membership = useActiveMembership();
  const selfCorrections = (membership?.settings.attendance as { allowSelfServiceCorrections?: boolean } | undefined)?.allowSelfServiceCorrections === true;
  const firstDayOfWeek = (membership?.settings.general as { firstDayOfWeek?: number } | undefined)?.firstDayOfWeek ?? 0;
  const today = todayIso(tz);
  const [params, setParams] = useSearchParams();
  const month = validMonth(params.get('month'), today.slice(0, 7));
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'calendar';
  const openId = params.get('day');
  const q = useSelfAttendance(month);
  const [correction, setCorrection] = useState<{ date: string; timezone: string } | null>(null);
  const totals = q.data?.totals;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === null) next.delete(k); else next.set(k, v); }
    setParams(next, { replace: true });
  };
  const dayTz = useMemo(() => q.data?.days[0]?.timezone ?? tz, [q.data, tz]);

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('attendance.title')} description={t('attendance.subtitle')}
        actions={selfCorrections ? <Button variant="outline" onClick={() => setCorrection({ date: today, timezone: dayTz })}><ClipboardList /> {t('attendance.requestCorrection')}</Button> : undefined} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-md border bg-card shadow-card">
          <Button variant="ghost" size="icon" aria-label={t('attendance.previousMonth')} onClick={() => set({ month: shiftMonth(month, -1), day: null })}><ChevronLeft className="rtl:rotate-180" /></Button>
          <span className="min-w-36 px-1 text-center text-sm font-medium tnum">{fmtDate(`${month}-01`, 'MMMM yyyy')}</span>
          <Button variant="ghost" size="icon" aria-label={t('attendance.nextMonth')} disabled={month >= today.slice(0, 7)} onClick={() => set({ month: shiftMonth(month, 1), day: null })}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
        {month !== today.slice(0, 7) ? <Button variant="outline" size="sm" onClick={() => set({ month: null, day: null })}>{t('attendance.thisMonth')}</Button> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={t('home.attendanceRate')} value={totals?.attendanceRate === null || totals?.attendanceRate === undefined ? '—' : `${Math.round(totals.attendanceRate * 100)}%`} icon={TrendingUp} tone="success" loading={q.isLoading} />
        <StatCard label={t('home.presentDays')} value={totals ? fmtDays(totals.present + totals.halfDay * 0.5) : '—'} hint={totals && totals.absent > 0 ? t('home.absentHint', { count: totals.absent }) : undefined} icon={CalendarCheck} loading={q.isLoading} />
        <StatCard label={t('home.lateArrivals')} value={totals?.late ?? '—'} hint={totals && totals.lateMinutes ? t('home.lateHint', { minutes: fmtMinutes(totals.lateMinutes) }) : undefined} icon={AlarmClock} tone={totals && totals.late > 0 ? 'warning' : 'default'} loading={q.isLoading} />
        <StatCard label={t('home.workedHours')} value={totals ? fmtMinutes(totals.workedMinutes) : '—'} icon={Clock} loading={q.isLoading} />
        <StatCard label={t('home.overtime')} value={totals ? fmtMinutes(totals.overtimeMinutes) : '—'} icon={Hourglass} tone="info" loading={q.isLoading} />
        <StatCard label={t('home.leaveDays')} value={totals?.leave ?? '—'} icon={CalendarX2} loading={q.isLoading} />
      </div>

      <Tabs value={tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList aria-label={t('attendance.title')} className="max-w-full overflow-x-auto">{TABS.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`attendance.tabs.${tb}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="calendar">
          {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data ? <Skeleton className="h-96 w-full" /> : <Card className="p-3"><MonthCalendar data={q.data} firstDayOfWeek={firstDayOfWeek} today={today} onSelect={(d) => set({ day: d.id })} /></Card>}
        </TabsContent>
        <TabsContent value="log">
          {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data ? <TableSkeleton cols={9} rows={6} /> : <DailyLog days={q.data.days} onSelect={(d) => set({ day: d.id })} />}
        </TabsContent>
        <TabsContent value="activity">{tab === 'activity' && employeeId ? <ActivityTab employeeId={employeeId} /> : null}</TabsContent>
        <TabsContent value="corrections">{tab === 'corrections' ? <CorrectionsTab timezone={dayTz} /> : null}</TabsContent>
      </Tabs>

      <RecordDialog recordId={openId} onClose={() => set({ day: null })} onRequestCorrection={(p) => { set({ day: null }); setCorrection({ date: p.attendanceDate, timezone: p.timezone ?? dayTz }); }} />
      <SelfCorrectionDialog key={correction ? `${correction.date}` : 'closed'} open={!!correction} onOpenChange={(o) => !o && setCorrection(null)} date={correction?.date ?? null} timezone={correction?.timezone ?? dayTz} />
    </div>
  );
}
