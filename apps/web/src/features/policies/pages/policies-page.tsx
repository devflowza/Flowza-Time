import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { ScrollText } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useCan } from '@/features/me/use-me';
import { POLICIES_NS } from '../i18n';
import { GroupsTab } from '../components/groups-tab';
import { PointsTab } from '../components/points-tab';
import { OvertimeTab } from '../components/overtime-tab';
import { PacksTab } from '../components/packs-tab';

const TABS = ['groups', 'points', 'overtime', 'packs'] as const;
type Tab = (typeof TABS)[number];

/** /attendance/policies?tab=groups|points|overtime|packs (Enterprise, attendance_policies). */
export default function PoliciesPage() {
  const { t } = useTranslation(POLICIES_NS);
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'groups';
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} actions={can('shift.view') ? <Button asChild variant="outline" size="sm"><Link to="/shifts?tab=rules"><ScrollText /> {t('editPolicies')}</Link></Button> : undefined} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')} className="max-w-full overflow-x-auto">
          {TABS.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tabs.${tb}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="groups">{tab === 'groups' ? <GroupsTab /> : null}</TabsContent>
        <TabsContent value="points">{tab === 'points' ? <PointsTab /> : null}</TabsContent>
        <TabsContent value="overtime">{tab === 'overtime' ? <OvertimeTab /> : null}</TabsContent>
        <TabsContent value="packs">{tab === 'packs' ? <PacksTab /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
