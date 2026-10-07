import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleSlash, Scale } from 'lucide-react';
import { countryRulePack } from '@flowza/contracts';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Input, Label, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeOptions } from '@/features/employees/api';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { useEmployeeGroupOptions, usePolicyResolution } from '@/features/policies/api';
import { useShiftOptions } from '../api';

/**
 * "Which policy applies?" (Enterprise, attendance_policies): an employee and a date → where they sit (country, branch,
 * department, group, shift), the policy the engine applies and why every other one does not (GET /attendance-policies/resolve).
 */
export function WhichPolicyCard() {
  const { t, i18n } = useTranslation('schedule');
  const tz = useOrgTimezone();
  const employees = useEmployeeOptions();
  const branches = useBranchOptions(true);
  const departments = useDepartmentOptions();
  const groups = useEmployeeGroupOptions();
  const shifts = useShiftOptions(true);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso(tz));
  const q = usePolicyResolution({ employeeId, date });
  const r = q.data;
  const country = (code: string | null) => { if (!code) return '—'; const p = countryRulePack(code); return p ? (i18n.language === 'ar' ? p.nameAr : p.name) : code; };
  const placement = r ? [
    { key: 'country', label: t('policyEditor.scope.country'), value: country(r.scope.countryCode) },
    { key: 'branch', label: t('policyList.branch'), value: r.scope.branchId ? branches.byId.get(r.scope.branchId)?.name ?? r.scope.branchId.slice(0, 8) : '—' },
    { key: 'department', label: t('policyEditor.scope.department'), value: r.scope.departmentId ? departments.byId.get(r.scope.departmentId)?.name ?? r.scope.departmentId.slice(0, 8) : '—' },
    { key: 'group', label: t('policyEditor.scope.group'), value: r.scope.employeeGroupId ? groups.byId.get(r.scope.employeeGroupId)?.name ?? r.scope.employeeGroupId.slice(0, 8) : '—' },
    { key: 'shift', label: t('policyEditor.scope.shift'), value: r.scope.shiftId ? shifts.byId.get(r.scope.shiftId)?.name ?? r.scope.shiftId.slice(0, 8) : '—' },
  ] : [];
  return (
    <Card data-testid="which-policy-card">
      <CardHeader><CardTitle className="flex items-center gap-2"><Scale className="size-4" /> {t('whichPolicy.title')}</CardTitle><CardDescription>{t('whichPolicy.hint')}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="wp-emp">{t('resolve.employee')}</Label><Combobox id="wp-emp" value={employeeId} onChange={setEmployeeId} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('resolve.selectEmployee')} /></div>
          <div className="space-y-1.5"><Label htmlFor="wp-date">{t('resolve.date')}</Label><Input id="wp-date" type="date" dir="ltr" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></div>
        </div>
        {!employeeId ? <p className="text-xs text-muted-foreground">{t('resolve.pickHint')}</p>
          : q.isLoading ? <Skeleton className="h-24 w-full" />
          : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          : r ? (
            <div className="space-y-3">
              <dl className="grid gap-x-6 gap-y-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-5">
                {placement.map((p) => <div key={p.key}><dt className="text-xs text-muted-foreground">{p.label}</dt><dd className="truncate font-medium">{p.value}</dd></div>)}
              </dl>
              <p className="text-sm" data-testid="which-policy-winner">
                {r.policy ? <>{t('whichPolicy.winner')} <span className="font-semibold">{r.policy.name}</span> <Badge variant="outline" className="ms-1 text-[10px]">{t('whichPolicy.specificity', { n: r.policy.specificity })}</Badge></> : t('whichPolicy.defaults')}
              </p>
              {r.candidates.length ? (
                <ul className="divide-y rounded-md border text-sm">
                  {r.candidates.map((c) => {
                    const winner = c.id === r.policy?.id;
                    return (
                      <li key={c.id} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', winner && 'bg-emerald-50/60 dark:bg-emerald-950/30')}>
                        {c.matches ? <CheckCircle2 className={cn('size-4', winner ? 'text-emerald-600' : 'text-muted-foreground')} aria-hidden /> : <CircleSlash className="size-4 text-muted-foreground" aria-hidden />}
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs text-muted-foreground tnum">{fmtDate(c.effectiveFrom)} → {c.effectiveTo ? fmtDate(c.effectiveTo) : '∞'}</span>
                        <span className="ms-auto text-xs">{winner ? <Badge variant="success">{t('whichPolicy.applies')}</Badge> : c.matches ? t('whichPolicy.lessSpecific') : t(`whichPolicy.mismatch.${c.mismatch ?? 'DATES'}`)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ) : null}
      </CardContent>
    </Card>
  );
}
