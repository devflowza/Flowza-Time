import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/layout/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useCan } from '@/features/me/use-me';
import { MEETINGS_NS } from '../i18n';
import { MeetingsTab } from '../components/meetings-tab';
import { RoomsTab } from '../components/rooms-tab';
import { AccessTab } from '../components/access-tab';

const TABS = ['meetings', 'rooms', 'access'] as const;
type Tab = (typeof TABS)[number];

/**
 * /meetings?tab=meetings|rooms|access (Enterprise, module meeting_rooms; meeting.view): the meetings with their attendance, the
 * rooms and their readers, and — for meeting.rooms holders — the room access log.
 */
export default function MeetingsPage() {
  const { t } = useTranslation(MEETINGS_NS);
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((tb) => tb !== 'access' || can('meeting.rooms'));
  const asked = params.get('tab') ?? '';
  const tab: Tab = (tabs as readonly string[]).includes(asked) ? (asked as Tab) : 'meetings';
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')} className="max-w-full overflow-x-auto">
          {tabs.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tabs.${tb}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="meetings">{tab === 'meetings' ? <MeetingsTab /> : null}</TabsContent>
        <TabsContent value="rooms">{tab === 'rooms' ? <RoomsTab /> : null}</TabsContent>
        {tabs.includes('access') ? <TabsContent value="access">{tab === 'access' ? <AccessTab /> : null}</TabsContent> : null}
      </Tabs>
    </div>
  );
}
