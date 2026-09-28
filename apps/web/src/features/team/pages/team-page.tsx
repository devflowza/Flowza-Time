import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { UsersRound } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useActiveMembership } from '@/features/me/use-me';
import { RecordDialog, type CorrectionPreset } from '@/features/attendance/components/record-dialog';
import { CorrectionDialog } from '@/features/corrections/components/correction-dialog';
import { usePendingCounts, useTeamAccess } from '../api';
import { TEAM_NS } from '../i18n';
import { TodayTab } from '../components/today-tab';
import { AttendanceTab } from '../components/attendance-tab';
import { LeaveTab } from '../components/leave-tab';
import { ApprovalsTab } from '../components/approvals-tab';
import { DelegationTab } from '../components/delegation-tab';

const TABS = ['today', 'attendance', 'leave', 'approvals', 'delegation'] as const;
type Tab = (typeof TABS)[number];

/**
 * /team?tab=today|attendance|leave|approvals|delegation — the line manager's workspace (HR portal Prompt 5, Finance B-61 …
 * B-66): today's board of the direct reports, their attendance through the HR register's month grid, their leave, what waits
 * for the manager, and delegation. Each tab asks the API with its own key (attendance / leave view_team or the organisation-
 * wide one); the API re-checks the reporting relationship and RLS applies the team predicate again.
 */
export default function TeamPage() {
  const { t } = useTranslation(TEAM_NS);
  const { t: tc } = useTranslation();
  const membership = useActiveMembership();
  const access = useTeamAccess();
  const counts = usePendingCounts(access.hasReports);
  const [params, setParams] = useSearchParams();
  const [recordId, setRecordId] = useState<string | null>(null);
  const [correction, setCorrection] = useState<{ open: boolean; preset?: CorrectionPreset }>({ open: false });

  if (!access.hasReports) {
    return <div className="page-container"><EmptyState icon={UsersRound} title={t('notManager')} description={t('notManagerHint')} action={<Link to="/" className="text-sm font-medium text-primary hover:underline">{tc('nav.dashboard')}</Link>} /></div>;
  }

  const visible = TABS.filter((tb) => (tb === 'attendance' ? access.attendance : tb === 'leave' ? access.leave : tb === 'delegation' ? access.delegate : true));
  const requested = params.get('tab') ?? 'today';
  const tab: Tab = (visible as readonly string[]).includes(requested) ? (requested as Tab) : 'today';
  const setTab = (v: string) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('tab', v); return n; }, { replace: true });
  const pending = counts.data?.total ?? 0;

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('title')} description={t('subtitle', { count: membership?.teamSize ?? 0 })} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={t('title')} className="max-w-full overflow-x-auto">
          {visible.map((tb) => (
            <TabsTrigger key={tb} value={tb}>
              {t(`tabs.${tb}`)}
              {tb === 'approvals' && pending > 0 ? <Badge variant="danger" className="ms-1.5 h-4 min-w-4 justify-center px-1 text-[10px] tnum" data-testid="approvals-tab-count">{pending > 99 ? '99+' : pending}</Badge> : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="today">{tab === 'today' ? <TodayTab enabled={access.attendance} onOpenRecord={setRecordId} onPending={() => setTab('approvals')} /> : null}</TabsContent>
        <TabsContent value="attendance">{tab === 'attendance' ? <AttendanceTab canCorrect={access.correct} onOpenRecord={setRecordId} /> : null}</TabsContent>
        <TabsContent value="leave">{tab === 'leave' ? <LeaveTab onOpenApprovals={() => setTab('approvals')} /> : null}</TabsContent>
        <TabsContent value="approvals">{tab === 'approvals' ? <ApprovalsTab /> : null}</TabsContent>
        <TabsContent value="delegation">{tab === 'delegation' ? <DelegationTab /> : null}</TabsContent>
      </Tabs>
      {/* read-only unless the caller may file corrections (attendance.correct); the API decides for which employee */}
      <RecordDialog recordId={recordId} onClose={() => setRecordId(null)} onRequestCorrection={access.correct ? (preset) => { setRecordId(null); setCorrection({ open: true, preset }); } : undefined} />
      <CorrectionDialog key={`${correction.open}-${correction.preset?.employeeId ?? ''}-${correction.preset?.attendanceDate ?? ''}`} open={correction.open} onOpenChange={(o) => setCorrection((c) => ({ ...c, open: o }))} preset={correction.preset} />
    </div>
  );
}
