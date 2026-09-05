import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/layout/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useCan } from '@/features/me/use-me';
import { BranchesTab } from '../components/tabs/branches-tab';
import { DepartmentsTab } from '../components/tabs/departments-tab';
import { DesignationsTab } from '../components/tabs/designations-tab';
import { TeamsTab } from '../components/tabs/teams-tab';

const TABS = ['branches', 'departments', 'designations', 'teams'] as const;
type Tab = (typeof TABS)[number];

export default function OrganizationPage() {
  const { t } = useTranslation('organization');
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'branches';
  const visible = TABS.filter((tb) => (tb === 'branches' ? can('branch.view') : can('department.view')));
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')} className="max-w-full overflow-x-auto">
          {visible.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tabs.${tb}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="branches">{tab === 'branches' ? <BranchesTab /> : null}</TabsContent>
        <TabsContent value="departments">{tab === 'departments' ? <DepartmentsTab /> : null}</TabsContent>
        <TabsContent value="designations">{tab === 'designations' ? <DesignationsTab /> : null}</TabsContent>
        <TabsContent value="teams">{tab === 'teams' ? <TeamsTab /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
