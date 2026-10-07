import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarClock, CheckCircle2, Clock4, ShieldAlert, Sparkles } from 'lucide-react';
import { ROUND_THE_CLOCK_TEMPLATES, roundTheClockInputSchema, type RoundTheClockTemplate } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, ErrorState, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@/components/ui';
import { Combobox, useDebounced } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useTeams } from '@/features/organization/api';
import { useBranchOptions } from '@/features/organization/lookups';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useApplyRoundTheClock, useRoundTheClockPreview } from '../api';
import { SCHED_NS } from '../i18n';
import { CREWS, type Crew } from '../model';
import { CrewCyclePreview } from './crew-cycle-preview';

/**
 * Shifts → Round-the-clock (Enterprise): pick a 24/7 template, see the shifts and every crew's cycle (the API's preview, which
 * proves each shift of each day is covered), optionally put teams on crews and set a coverage target, then create it all in
 * one go. The recalculation the API queues for the crews' past days is a QUEUE job: its toast points at the attendance
 * recalculation tab, never at /sync.
 */
export function RoundTheClockTab() {
  const { t } = useTranslation(SCHED_NS);
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const canManage = can('shift.manage');
  const canAssign = can('shift.assign');
  const [template, setTemplate] = useState<RoundTheClockTemplate>('TWO_SHIFT_4ON4OFF');
  const [codePrefix, setCodePrefix] = useState('247');
  const [namePrefix, setNamePrefix] = useState(() => t('rtc.defaultName'));
  const [firstShiftStart, setFirstShiftStart] = useState('06:00');
  const [anchorDate, setAnchorDate] = useState(() => todayIso(tz));
  const [breakMinutes, setBreakMinutes] = useState(60);
  const [crewTeams, setCrewTeams] = useState<Record<Crew, string | null>>({ A: null, B: null, C: null, D: null });
  const [coverageOn, setCoverageOn] = useState(false);
  const [coverageBranch, setCoverageBranch] = useState<string | null>(null);
  const [minHeadcount, setMinHeadcount] = useState(1);
  const teams = useTeams({ pageSize: 200, sort: 'name', status: 'active' }, canAssign);
  const branches = useBranchOptions();
  const apply = useApplyRoundTheClock();
  const teamOptions = useMemo(() => (teams.data?.data ?? []).map((tm) => ({ value: tm.id, label: tm.name, description: tm.branchName ?? tm.code })), [teams.data]);

  const input = {
    template, codePrefix, namePrefix, firstShiftStart, anchorDate, breakMinutes,
    crewTeams: CREWS.flatMap((crew) => { const teamId = crewTeams[crew]; return teamId ? [{ crew, teamId }] : []; }),
    coverage: coverageOn && coverageBranch ? { branchId: coverageBranch, minHeadcount } : null,
  };
  const parsed = roundTheClockInputSchema.safeParse(input);
  const issue = (path: string) => (parsed.success ? undefined : parsed.error.issues.find((i) => i.path[0] === path)?.message);
  // the preview depends on the template fields only; debounced on a string so an unchanged input never re-asks
  const previewKey = parsed.success ? JSON.stringify({ template, codePrefix, namePrefix, firstShiftStart, anchorDate, breakMinutes }) : '';
  const debouncedKey = useDebounced(previewKey, 300);
  const previewInput = useMemo(() => (debouncedKey ? (JSON.parse(debouncedKey) as Parameters<typeof useRoundTheClockPreview>[0]) : null), [debouncedKey]);
  const preview = useRoundTheClockPreview(previewInput);
  const plan = preview.data;
  const coverageIncomplete = coverageOn && !coverageBranch;

  const onApply = () => {
    if (!parsed.success || coverageIncomplete) return;
    apply.mutate(parsed.data, {
      onSuccess: (r) => {
        toast.success(t('rtc.applied', { shifts: r.shiftIds.length, patterns: r.patternIds.length, assignments: r.assignmentIds.length }));
        if (r.recalculationJobId) toastJobQueued(r.recalculationJobId, navigate, t('rtc.recalcHint'), { to: '/attendance?tab=recalc' });
      },
      onError: toastError,
    });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <Card>
        <CardHeader><CardTitle>{t('rtc.title')}</CardTitle><CardDescription>{t('rtc.hint')}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <FormField label={t('rtc.template')} htmlFor="rtc-template" required hint={t(`templates.${template}.hint`)}>
            <Select value={template} onValueChange={(v) => setTemplate(v as RoundTheClockTemplate)}>
              <SelectTrigger id="rtc-template"><SelectValue /></SelectTrigger>
              <SelectContent>{ROUND_THE_CLOCK_TEMPLATES.map((k) => <SelectItem key={k} value={k}>{t(`templates.${k}.name`)}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('rtc.codePrefix')} htmlFor="rtc-code" required error={issue('codePrefix')} hint={t('rtc.codePrefixHint', { prefix: codePrefix || '…' })}>
              <Input id="rtc-code" dir="ltr" value={codePrefix} maxLength={20} onChange={(e) => setCodePrefix(e.target.value)} aria-invalid={!!issue('codePrefix')} />
            </FormField>
            <FormField label={t('rtc.namePrefix')} htmlFor="rtc-name" required error={issue('namePrefix')}>
              <Input id="rtc-name" value={namePrefix} maxLength={60} onChange={(e) => setNamePrefix(e.target.value)} aria-invalid={!!issue('namePrefix')} />
            </FormField>
            <FormField label={t('rtc.firstShiftStart')} htmlFor="rtc-start" required error={issue('firstShiftStart')}>
              <Input id="rtc-start" type="time" dir="ltr" value={firstShiftStart} onChange={(e) => setFirstShiftStart(e.target.value)} />
            </FormField>
            <FormField label={t('rtc.breakMinutes')} htmlFor="rtc-break" error={issue('breakMinutes')}>
              <Input id="rtc-break" type="number" min={0} max={120} value={breakMinutes} onChange={(e) => setBreakMinutes(Number(e.target.value))} />
            </FormField>
          </div>
          <FormField label={t('rtc.anchorDate')} htmlFor="rtc-anchor" required error={issue('anchorDate')} hint={t('rtc.anchorDateHint')}>
            <Input id="rtc-anchor" type="date" dir="ltr" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} />
          </FormField>

          {canAssign ? (
            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{t('rtc.crewTeams')}</legend>
              <p className="text-xs text-muted-foreground">{t('rtc.crewTeamsHint')}</p>
              {CREWS.map((crew) => (
                <div key={crew} className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
                  <Label htmlFor={`rtc-team-${crew}`}>{t('rtc.crewName', { crew })}</Label>
                  <Combobox id={`rtc-team-${crew}`} value={crewTeams[crew]} onChange={(v) => setCrewTeams((c) => ({ ...c, [crew]: v }))} options={teamOptions} loading={teams.isLoading} clearable placeholder={t('rtc.noTeam')} />
                </div>
              ))}
              {issue('crewTeams') ? <p role="alert" className="text-xs text-destructive">{t('rtc.crewTeamsUnique')}</p> : null}
            </fieldset>
          ) : null}

          <fieldset className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Checkbox id="rtc-coverage" checked={coverageOn} onCheckedChange={(v) => setCoverageOn(v === true)} />
              <Label htmlFor="rtc-coverage">{t('rtc.coverage')}</Label>
            </div>
            {coverageOn ? (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem]">
                <Combobox id="rtc-coverage-branch" value={coverageBranch} onChange={setCoverageBranch} options={branches.options} loading={branches.isLoading} placeholder={tc('common.branch')} aria-invalid={coverageIncomplete} />
                <Input aria-label={t('rtc.minHeadcount')} type="number" min={1} max={10000} value={minHeadcount} onChange={(e) => setMinHeadcount(Number(e.target.value))} />
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('rtc.coverageHint')}</p>
          </fieldset>

          {canManage ? (
            <Button className="w-full" onClick={onApply} disabled={!parsed.success || coverageIncomplete || !plan?.coverageCheck.covered} loading={apply.isPending} data-testid="rtc-apply">
              <Sparkles /> {t('rtc.apply')}
            </Button>
          ) : <p className="text-sm text-muted-foreground">{t('rtc.needsManage')}</p>}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader><CardTitle>{t('rtc.previewTitle')}</CardTitle><CardDescription>{t('rtc.previewHint')}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {!parsed.success && !plan ? <p className="text-sm text-muted-foreground">{t('rtc.fixForm')}</p>
            : preview.isError ? <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
            : !plan ? <Skeleton className="h-40 w-full" />
            : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {plan.coverageCheck.covered
                    ? <Badge variant="success"><CheckCircle2 className="size-3.5" aria-hidden /> {t('rtc.covered')}</Badge>
                    : <Badge variant="danger"><ShieldAlert className="size-3.5" aria-hidden /> {t('rtc.notCovered')}</Badge>}
                  <Badge variant="outline"><Clock4 className="size-3.5" aria-hidden /> {t('rtc.weeklyHours', { hours: plan.averageWeeklyHours })}</Badge>
                  <Badge variant="outline"><CalendarClock className="size-3.5" aria-hidden /> {t('rtc.cycleDays', { count: plan.crews[0]?.cycleLengthDays ?? 0 })}</Badge>
                </div>
                <ul className="grid gap-2 sm:grid-cols-3" aria-label={t('rtc.shifts')}>
                  {plan.shifts.map((s) => (
                    <li key={s.key} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                      <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
                      <span className="min-w-0"><span className="block truncate font-medium">{s.name}</span><span className="text-xs text-muted-foreground tnum" dir="ltr">{s.code} · {s.startTime}–{s.endTime}</span></span>
                    </li>
                  ))}
                </ul>
                <CrewCyclePreview plan={plan} />
                <p className="text-xs text-muted-foreground">{t('rtc.patternsCreated', { codes: plan.crews.map((c) => c.code).join(', ') })}</p>
              </>
            )}
        </CardContent>
      </Card>
    </div>
  );
}
