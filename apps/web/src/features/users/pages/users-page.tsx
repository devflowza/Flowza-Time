import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/layout/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { MembersTab } from '../components/members-tab';
import { InvitationsTab } from '../components/invitations-tab';
import { RolesTab } from '../components/roles-tab';

const TABS = ['members', 'invitations', 'roles'] as const;
type Tab = (typeof TABS)[number];

export default function UsersPage() {
  const { t } = useTranslation('users');
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'members';
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')}>{TABS.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tabs.${tb}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="members">{tab === 'members' ? <MembersTab /> : null}</TabsContent>
        <TabsContent value="invitations">{tab === 'invitations' ? <InvitationsTab /> : null}</TabsContent>
        <TabsContent value="roles">{tab === 'roles' ? <RolesTab /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
