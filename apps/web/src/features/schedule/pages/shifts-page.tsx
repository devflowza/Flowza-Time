import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/layout/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { ShiftsTab } from '../components/tabs/shifts-tab';
import { PatternsTab } from '../components/tabs/patterns-tab';
import { AssignmentsTab } from '../components/tabs/assignments-tab';
import { RuleSetsTab } from '../components/tabs/rule-sets-tab';
// HR portal Prompt 6b (Finance ATT-105): the monthly roster
import { AA_NS } from '@/features/attendance-admin/i18n';
import { RosterTab } from '@/features/attendance-admin/components/roster-tab';
import { useCan, useModuleEnabled } from '@/features/me/use-me';
// Enterprise (module shift_requests): the employees' shift change requests; decided in the approvals inbox
import { SR_NS } from '@/features/shift-requests/i18n';
import { ShiftRequestsTab } from '@/features/shift-requests/components/shift-requests-tab';
// Enterprise round-the-clock scheduling (module advanced_scheduling): templates, coverage, double shifts
import { SCHED_NS } from '@/features/scheduling/i18n';
import { RoundTheClockTab } from '@/features/scheduling/components/round-the-clock-tab';
import { CoverageTab } from '@/features/scheduling/components/coverage-tab';
import { DoubleShiftsTab } from '@/features/scheduling/components/double-shifts-tab';

const BASE_TABS = ['shifts', 'patterns', 'assignments', 'rules', 'roster'] as const;
/** Shown only while the organisation has shift_requests (Enterprise) and the caller holds attendance.view. */
const REQUEST_TABS = ['requests'] as const;
/** Shown only while the organisation has advanced_scheduling (Enterprise). */
const SCHEDULING_TABS = ['round-the-clock', 'coverage', 'double-shifts'] as const;
const SCHEDULING_LABELS: Record<(typeof SCHEDULING_TABS)[number], string> = { 'round-the-clock': 'tabs.roundTheClock', coverage: 'tabs.coverage', 'double-shifts': 'tabs.doubleShifts' };
type Tab = (typeof BASE_TABS)[number] | (typeof REQUEST_TABS)[number] | (typeof SCHEDULING_TABS)[number];
const isSchedulingTab = (tb: string): tb is (typeof SCHEDULING_TABS)[number] => (SCHEDULING_TABS as readonly string[]).includes(tb);

/** /shifts?tab=shifts|patterns|assignments|rules|roster (+ requests with shift_requests, + round-the-clock|coverage|double-shifts with advanced_scheduling) */
export default function ShiftsPage() {
  const { t } = useTranslation('schedule');
  const { t: ta } = useTranslation(AA_NS);
  const { t: tr } = useTranslation(SR_NS);
  const { t: ts } = useTranslation(SCHED_NS);
  const can = useCan();
  const requestsOn = useModuleEnabled('shift_requests') && can('attendance.view');
  const advanced = useModuleEnabled('advanced_scheduling');
  const tabs: readonly Tab[] = [...BASE_TABS, ...(requestsOn ? REQUEST_TABS : []), ...(advanced ? SCHEDULING_TABS : [])];
  const [params, setParams] = useSearchParams();
  const tab: Tab = (tabs as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'shifts';
  const label = (tb: Tab): string => (tb === 'roster' ? ta('roster.tab') : tb === 'requests' ? tr('hr.tab') : isSchedulingTab(tb) ? ts(SCHEDULING_LABELS[tb]) : t(`tabs.${tb}`));
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')} className="max-w-full overflow-x-auto">
          {tabs.map((tb) => <TabsTrigger key={tb} value={tb}>{label(tb)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="shifts">{tab === 'shifts' ? <ShiftsTab /> : null}</TabsContent>
        <TabsContent value="patterns">{tab === 'patterns' ? <PatternsTab /> : null}</TabsContent>
        <TabsContent value="assignments">{tab === 'assignments' ? <AssignmentsTab /> : null}</TabsContent>
        <TabsContent value="rules">{tab === 'rules' ? <RuleSetsTab /> : null}</TabsContent>
        <TabsContent value="roster">{tab === 'roster' ? <RosterTab /> : null}</TabsContent>
        {requestsOn ? <TabsContent value="requests">{tab === 'requests' ? <ShiftRequestsTab /> : null}</TabsContent> : null}
        {advanced ? <>
          <TabsContent value="round-the-clock">{tab === 'round-the-clock' ? <RoundTheClockTab /> : null}</TabsContent>
          <TabsContent value="coverage">{tab === 'coverage' ? <CoverageTab /> : null}</TabsContent>
          <TabsContent value="double-shifts">{tab === 'double-shifts' ? <DoubleShiftsTab /> : null}</TabsContent>
        </> : null}
      </Tabs>
    </div>
  );
}
