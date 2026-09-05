import { useTranslation } from 'react-i18next';
import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtDateTime, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CalculationTrace } from '../types';
import type { Tone } from '../status';

const ROLE_TONE: Record<string, Tone> = { IN: 'success', OUT: 'info', BREAK_START: 'neutral', BREAK_END: 'neutral', IGNORED: 'secondary', DUPLICATE: 'warning', OUT_OF_WINDOW: 'danger' };

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Human-readable rendering of the engine's CalculationTrace (inputs → punch timeline → steps). Every section tolerates
 * missing or partially filled data: old records and manual statuses may carry an empty `{}` trace.
 */
export function TraceView({ trace, timezone }: { trace: CalculationTrace | null | undefined; timezone: string }) {
  const { t } = useTranslation('attendance');
  const inputs = trace?.inputs ?? null;
  const punches = Array.isArray(trace?.punches) ? trace.punches : [];
  const steps = Array.isArray(trace?.steps) ? trace.steps : [];
  const empty = !inputs && punches.length === 0 && steps.length === 0;
  if (empty) return <EmptyState title={t('trace.empty')} description={t('trace.emptyHint')} className="py-8" />;

  const inputRows: { label: string; value: string }[] = inputs ? [
    { label: t('trace.inputs.timezone'), value: inputs.timezone ?? timezone },
    { label: t('trace.inputs.shift'), value: inputs.shiftId ? `${inputs.shiftType ?? ''} ${inputs.shiftId.slice(0, 8)}…`.trim() : t('trace.inputs.noShift') },
    { label: t('trace.inputs.ruleSet'), value: inputs.ruleSetId ? `${inputs.ruleSetId.slice(0, 8)}…` : t('trace.inputs.defaultRules') },
    { label: t('trace.inputs.window'), value: inputs.window?.start && inputs.window?.end ? `${fmtDateTime(inputs.window.start, inputs.timezone ?? timezone, 'dd MMM HH:mm')} → ${fmtDateTime(inputs.window.end, inputs.timezone ?? timezone, 'dd MMM HH:mm')}` : '—' },
    { label: t('trace.inputs.holiday'), value: inputs.holiday ?? '—' },
    { label: t('trace.inputs.leave'), value: inputs.leave ?? '—' },
    { label: t('trace.inputs.weeklyOff'), value: inputs.weeklyOff ? t('common:common.yes') : t('common:common.no') },
  ] : [];

  return (
    <div className="space-y-5" data-testid="trace-view">
      {trace?.engineVersion ? <p className="text-xs text-muted-foreground" dir="ltr">{t('trace.engine', { version: trace.engineVersion })}</p> : null}

      <section>
        <h4 className="mb-2 text-sm font-semibold">{t('trace.sections.inputs')}</h4>
        {inputRows.length ? (
          <dl className="grid gap-x-6 gap-y-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {inputRows.map((r) => <div key={r.label} className="min-w-0"><dt className="text-xs text-muted-foreground">{r.label}</dt><dd className="truncate font-mono text-xs tnum" dir="ltr" title={r.value}>{r.value}</dd></div>)}
          </dl>
        ) : <p className="text-xs text-muted-foreground">{t('trace.noInputs')}</p>}
      </section>

      <section>
        <h4 className="mb-2 text-sm font-semibold">{t('trace.sections.punches', { count: punches.length })}</h4>
        {punches.length === 0 ? <p className="text-xs text-muted-foreground">{t('trace.noPunches')}</p> : (
          <ol className="relative ms-2 space-y-2 border-s ps-4">
            {punches.map((p, i) => {
              const role = p.role ?? 'IGNORED';
              const faded = role === 'IGNORED' || role === 'DUPLICATE' || role === 'OUT_OF_WINDOW';
              return (
                <li key={p.eventId ?? i} className="relative">
                  <span className={cn('absolute -start-[21px] top-1.5 size-2.5 rounded-full border-2 border-card', faded ? 'bg-muted-foreground/50' : role === 'IN' ? 'bg-emerald-500' : role === 'OUT' ? 'bg-blue-500' : 'bg-slate-400')} aria-hidden />
                  <div className={cn('flex flex-wrap items-center gap-2 text-sm', faded && 'text-muted-foreground')}>
                    <span className="font-mono text-xs tnum" dir="ltr">{p.punchedAt ? fmtTime(p.punchedAt, timezone, 'dd MMM HH:mm:ss') : p.local ?? '—'}</span>
                    <Badge variant={ROLE_TONE[role] ?? 'neutral'}>{t(`trace.roles.${role}`, { defaultValue: role })}</Badge>
                    {p.note ? <span className="text-xs text-muted-foreground">{p.note}</span> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section>
        <h4 className="mb-2 text-sm font-semibold">{t('trace.sections.steps', { count: steps.length })}</h4>
        {steps.length === 0 ? <p className="text-xs text-muted-foreground">{t('trace.noSteps')}</p> : (
          <Table>
            <TableHeader><TableRow><TableHead className="w-8">#</TableHead><TableHead>{t('trace.columns.step')}</TableHead><TableHead>{t('trace.columns.detail')}</TableHead><TableHead>{t('trace.columns.values')}</TableHead></TableRow></TableHeader>
            <TableBody>
              {steps.map((s, i) => (
                <TableRow key={i}>
                  <TableCell className="tnum text-xs text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-mono text-xs" dir="ltr">{s.step ?? '—'}</TableCell>
                  <TableCell className="text-sm">{s.detail ?? '—'}</TableCell>
                  <TableCell>
                    {s.values && Object.keys(s.values).length ? (
                      <span className="inline-flex flex-wrap gap-1">{Object.entries(s.values).map(([k, v]) => <span key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] tnum" dir="ltr">{k}={fmtValue(v)}</span>)}</span>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
