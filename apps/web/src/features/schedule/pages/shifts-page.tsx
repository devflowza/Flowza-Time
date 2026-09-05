import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/layout/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { ShiftsTab } from '../components/tabs/shifts-tab';
import { PatternsTab } from '../components/tabs/patterns-tab';
import { AssignmentsTab } from '../components/tabs/assignments-tab';
import { RuleSetsTab } from '../components/tabs/rule-sets-tab';

const TABS = ['shifts', 'patterns', 'assignments', 'rules'] as const;
type Tab = (typeof TABS)[number];

/** /shifts?tab=shifts|patterns|assignments|rules */
export default function ShiftsPage() {
  const { t } = useTranslation('schedule');
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'shifts';
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')} className="max-w-full overflow-x-auto">
          {TABS.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tabs.${tb}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="shifts">{tab === 'shifts' ? <ShiftsTab /> : null}</TabsContent>
        <TabsContent value="patterns">{tab === 'patterns' ? <PatternsTab /> : null}</TabsContent>
        <TabsContent value="assignments">{tab === 'assignments' ? <AssignmentsTab /> : null}</TabsContent>
        <TabsContent value="rules">{tab === 'rules' ? <RuleSetsTab /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
