import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge, Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { useCan } from '@/features/me/use-me';
import { useUnmatchedPunches } from '@/features/attendance/workspace-api';
import { DEVICES_HUB_TABS, HUB_TAB_ROUTES, type DevicesHubTab } from '../hub';

/** Devices & punches navigation: Devices · PIN mapping · Unmapped punches (with the open count) · Punch log — each its own URL. */
export function DevicesHubTabs({ value }: { value: DevicesHubTab }) {
  const { t } = useTranslation('devices');
  const navigate = useNavigate();
  const can = useCan();
  const visible = DEVICES_HUB_TABS.filter((k) => can(...HUB_TAB_ROUTES[k].permissions));
  const unmatched = useUnmatchedPunches({ page: 1, pageSize: 1, status: 'unmatched' }, visible.includes('unmapped'));
  const open = unmatched.data?.meta.total ?? 0;
  if (visible.length < 2) return null;
  return (
    <Tabs value={value} onValueChange={(v) => navigate(HUB_TAB_ROUTES[v as DevicesHubTab].to)}>
      <TabsList aria-label={t('hub.title')} className="h-auto max-w-full flex-wrap justify-start">
        {visible.map((k) => {
          const Icon = HUB_TAB_ROUTES[k].icon;
          return (
            <TabsTrigger key={k} value={k} className="gap-1.5">
              <Icon className="size-4" aria-hidden /> {t(`hub.tabs.${k}`)}
              {k === 'unmapped' && open > 0 ? <Badge variant="danger" className="px-1.5 py-0 tnum" aria-label={t('hub.openUnmapped', { count: open })}>{fmtNumber(open)}</Badge> : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
