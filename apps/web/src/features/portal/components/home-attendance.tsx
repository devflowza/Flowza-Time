import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Fingerprint, LogIn, LogOut } from 'lucide-react';
import type { SelfOverviewDto } from '@flowza/contracts';
import { Badge, Button, Card } from '@/components/ui';
import { fmtTime } from '@/lib/format';
import { PA_NS } from '../attendance-i18n';

/**
 * The portal home's check-in strip (HR portal Prompt 4): today's punch state and a button to the check-in page. Rendered
 * only when the organisation allows self-service check-in (an API from before Prompt 4 sends no `punch` at all).
 */
export function HomePunchCard({ overview }: { overview: SelfOverviewDto | undefined }) {
  const { t } = useTranslation(PA_NS);
  const p = overview?.punch;
  if (!p || !p.checkInEnabled) return null;
  const tz = overview?.timezone ?? 'UTC';
  const checkedIn = p.lastDirection === 'in';
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="home-punch">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-brand-700" aria-hidden><Fingerprint className="size-5" /></span>
        <div>
          <p className="text-sm font-semibold">{t('home.punchTitle')}</p>
          <p className="text-xs text-muted-foreground tnum">
            {p.lastPunchAt ? t(checkedIn ? 'home.lastIn' : 'home.lastOut', { time: fmtTime(p.lastPunchAt, tz) }) : t('home.notYet')}
            {p.punchesToday > 0 ? ` · ${t('home.punchesToday', { count: p.punchesToday })}` : ''}
          </p>
        </div>
      </div>
      <Button asChild><Link to="/my/checkin">{checkedIn ? <><LogOut /> {t('checkin.checkOut')}</> : <><LogIn /> {t('checkin.checkIn')}</>}</Link></Button>
    </Card>
  );
}

/** Reasons, regularisations and swaps waiting on someone — each links to its tab of My requests. */
export function PendingSelfItems({ overview }: { overview: SelfOverviewDto | undefined }) {
  const { t } = useTranslation(PA_NS);
  if (!overview) return null;
  const items = [
    { n: overview.reasonsRequired ?? 0, key: 'home.reasonsRequired', to: '/my/attendance?tab=recent', tone: 'danger' as const },
    { n: overview.infoRequestedNotes ?? 0, key: 'home.infoRequested', to: '/my/requests?tab=reasons', tone: 'info' as const },
    { n: overview.pendingNotes ?? 0, key: 'home.pendingNotes', to: '/my/requests?tab=reasons', tone: 'warning' as const },
    { n: overview.pendingRegularisations ?? 0, key: 'home.pendingRegularisations', to: '/my/requests?tab=regularisations', tone: 'warning' as const },
    { n: overview.pendingSwaps ?? 0, key: 'home.pendingSwaps', to: '/my/requests?tab=swaps', tone: 'warning' as const },
  ].filter((i) => i.n > 0);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="home-pending">
      {items.map((i) => <Link key={i.key} to={i.to}><Badge variant={i.tone} dot>{t(i.key, { count: i.n })}</Badge></Link>)}
    </div>
  );
}
