import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FilePlus2 } from 'lucide-react';
import type { CountryPackCode, CountryRulePack } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Skeleton } from '@/components/ui';
import { fmtDate, fmtMinutes } from '@/lib/format';
import { useCan } from '@/features/me/use-me';
import { RuleSetDialog } from '@/features/schedule/components/rule-set-dialog';
import { POLICIES_NS } from '../i18n';
import { useCountryPacks } from '../api';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function PackCard({ pack, onCreate }: { pack: CountryRulePack; onCreate?: () => void }) {
  const { t, i18n } = useTranslation(POLICIES_NS);
  const figures: Array<{ key: string; label: string; value: string }> = [
    { key: 'day', label: t('packs.daily'), value: fmtMinutes(pack.dailyMinutes) },
    { key: 'week', label: t('packs.weekly'), value: fmtMinutes(pack.weeklyMinutes) },
    { key: 'maxDay', label: t('packs.maxDailyWork'), value: pack.maxDailyWorkMinutes === null ? t('packs.notSet') : fmtMinutes(pack.maxDailyWorkMinutes) },
    { key: 'maxOt', label: t('packs.maxDailyOvertime'), value: pack.maxDailyOvertimeMinutes === null ? t('packs.notSet') : fmtMinutes(pack.maxDailyOvertimeMinutes) },
    { key: 'ramadan', label: t('packs.ramadan'), value: pack.ramadan ? t(pack.ramadan.appliesTo === 'all' ? 'packs.ramadanAll' : 'packs.ramadanFlagged', { hours: fmtMinutes(pack.ramadan.dailyMinutes) }) : t('packs.notSet') },
    { key: 'rates', label: t('packs.rates'), value: t('packs.ratesLine', { regular: pack.overtimeRates.regular, weeklyOff: pack.overtimeRates.weeklyOff, holiday: pack.overtimeRates.holiday }) },
    { key: 'night', label: t('packs.night'), value: pack.night ? t('packs.nightLine', { start: pack.night.start, end: pack.night.end, rate: pack.night.rate }) : t('packs.notSet') },
    { key: 'rest', label: t('packs.weeklyRest'), value: pack.weeklyOffDays.map((d) => t(`packs.days.${WEEKDAYS[d] ?? 'sun'}`)).join(', ') },
  ];
  return (
    <Card data-testid={`pack-${pack.code}`}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2"><span>{i18n.language === 'ar' ? pack.nameAr : pack.name}</span><Badge variant="outline" className="font-mono text-[10px]">{pack.code} · {pack.version}</Badge></CardTitle>
        <CardDescription>{pack.law}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {figures.map((f) => <div key={f.key}><dt className="text-xs text-muted-foreground">{f.label}</dt><dd className="tnum">{f.value}</dd></div>)}
        </dl>
        {pack.notes.length ? <ul className="list-disc space-y-0.5 ps-4 text-xs text-muted-foreground" dir="ltr">{pack.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        <div className="space-y-0.5">
          <p className="text-xs font-medium">{t('packs.sources')}</p>
          <ul className="space-y-0.5">{pack.sources.map((s) => <li key={s}><a href={s} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-xs text-primary hover:underline" dir="ltr"><ExternalLink className="size-3 shrink-0" /><span className="truncate">{new URL(s).hostname}</span></a></li>)}</ul>
        </div>
        <p className="text-[11px] text-muted-foreground">{t('packs.verified', { date: fmtDate(pack.verifiedOn) })}</p>
        {onCreate ? <Button size="sm" variant="outline" onClick={onCreate}><FilePlus2 /> {t('packs.createPolicy')}</Button> : null}
      </CardContent>
    </Card>
  );
}

/** Country rule packs: the statutory figures a policy can start from and is checked against — defaults, never enforcement. */
export function PacksTab() {
  const { t } = useTranslation(POLICIES_NS);
  const can = useCan();
  const q = useCountryPacks();
  const [creating, setCreating] = useState<CountryPackCode | null>(null);
  const canCreate = can('attendance.manage_rules');
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('packs.hint')}</p>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : !q.data ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72 w-full" />)}</div>
        : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{q.data.map((p) => <PackCard key={p.code} pack={p} onCreate={canCreate ? () => setCreating(p.code) : undefined} />)}</div>}
      {creating ? <RuleSetDialog key={creating} open onOpenChange={(o) => !o && setCreating(null)} ruleSet={null} pack={creating} /> : null}
    </div>
  );
}
