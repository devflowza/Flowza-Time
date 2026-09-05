import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Input, Label, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeOptions } from '@/features/employees/api';
import { useShiftResolution } from '../api';

/** "Which shift applies to X on date D?" — runs the same resolution as the engine (GET /shifts/resolve). */
export function ResolveShiftCard() {
  const { t } = useTranslation('schedule');
  const tz = useOrgTimezone();
  const employees = useEmployeeOptions();
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso(tz));
  const q = useShiftResolution({ employeeId, date });
  const r = q.data;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Search className="size-4" /> {t('resolve.title')}</CardTitle><CardDescription>{t('resolve.hint')}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="rs-emp">{t('resolve.employee')}</Label><Combobox id="rs-emp" value={employeeId} onChange={setEmployeeId} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('resolve.selectEmployee')} /></div>
          <div className="space-y-1.5"><Label htmlFor="rs-date">{t('resolve.date')}</Label><Input id="rs-date" type="date" dir="ltr" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></div>
        </div>
        {!employeeId ? <p className="text-xs text-muted-foreground">{t('resolve.pickHint')}</p>
          : q.isLoading ? <Skeleton className="h-16 w-full" />
          : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          : r ? (
            <dl className="grid gap-x-6 gap-y-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">{t('resolve.shift')}</dt><dd className="flex items-center gap-2 font-medium">{r.isPatternOff ? <Badge variant="neutral">{t('patterns.off')}</Badge> : r.shift ? <><span className="size-2.5 rounded-full" style={{ backgroundColor: r.shift.color ?? '#94a3b8' }} />{r.shift.name} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{r.shift.type === 'FIXED' ? `${r.shift.startTime}–${r.shift.endTime}` : t('shifts.types.FLEXIBLE')}</span></> : <span className="text-muted-foreground">{t('resolve.noShift')}</span>}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('resolve.source')}</dt><dd>{r.assignment ? <>{t(`assignments.targets.${r.assignment.targetType}`, { defaultValue: r.assignment.targetType })}{r.assignment.shiftPatternId ? <span className="text-muted-foreground"> · {t('resolve.patternDay', { n: (r.patternDay ?? 0) + 1 })}</span> : null}</> : <span className="text-muted-foreground">{t('resolve.noAssignment')}</span>}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('resolve.effective')}</dt><dd className="tnum">{r.assignment ? `${r.assignment.effectiveFrom} → ${r.assignment.effectiveTo ?? '∞'}` : '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('resolve.ruleSet')}</dt><dd>{r.ruleSet ? r.ruleSet.name : <span className="text-muted-foreground">{t('resolve.defaultRules')}</span>}</dd></div>
            </dl>
          ) : null}
      </CardContent>
    </Card>
  );
}
