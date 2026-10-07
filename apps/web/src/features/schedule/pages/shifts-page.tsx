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
// Enterprise (module shift_requests): the employees' shift change requests; decided in the approvals inbox
import { useCan, useModuleEnabled } from '@/features/me/use-me';
import { SR_NS } from '@/features/shift-requests/i18n';
import { ShiftRequestsTab } from '@/features/shift-requests/components/shift-requests-tab';

const TABS = ['shifts', 'patterns', 'assignments', 'rules', 'roster', 'requests'] as const;
type Tab = (typeof TABS)[number];

/** /shifts?tab=shifts|patterns|assignments|rules|roster|requests */
export default function ShiftsPage() {
  const { t } = useTranslation('schedule');
  const { t: ta } = useTranslation(AA_NS);
  const { t: ts } = useTranslation(SR_NS);
  const can = useCan();
  const requestsOn = useModuleEnabled('shift_requests') && can('attendance.view');
  const tabs = TABS.filter((tb) => tb !== 'requests' || requestsOn);
  const [params, setParams] = useSearchParams();
  const tab: Tab = (tabs as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'shifts';
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')} className="max-w-full overflow-x-auto">
          {tabs.map((tb) => <TabsTrigger key={tb} value={tb}>{tb === 'roster' ? ta('roster.tab') : tb === 'requests' ? ts('hr.tab') : t(`tabs.${tb}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="shifts">{tab === 'shifts' ? <ShiftsTab /> : null}</TabsContent>
        <TabsContent value="patterns">{tab === 'patterns' ? <PatternsTab /> : null}</TabsContent>
        <TabsContent value="assignments">{tab === 'assignments' ? <AssignmentsTab /> : null}</TabsContent>
        <TabsContent value="rules">{tab === 'rules' ? <RuleSetsTab /> : null}</TabsContent>
        <TabsContent value="roster">{tab === 'roster' ? <RosterTab /> : null}</TabsContent>
        {requestsOn ? <TabsContent value="requests">{tab === 'requests' ? <ShiftRequestsTab /> : null}</TabsContent> : null}
      </Tabs>
    </div>
  );
}
