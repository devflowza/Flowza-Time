import { useTranslation } from 'react-i18next';
import type { RoundTheClockPlanDto } from '@flowza/contracts';
import { cn } from '@/lib/utils';
import { SCHED_NS } from '../i18n';

/**
 * One row per crew, one cell per day of the cycle: what each crew works from the anchor date on (the crew's offset is folded
 * into its sequence by the API, so day 1 is the anchor date for every crew). Shift cells carry the shift's own colour (data,
 * like the rotation patterns tab); off days are muted.
 */
export function CrewCyclePreview({ plan }: { plan: RoundTheClockPlanDto }) {
  const { t } = useTranslation(SCHED_NS);
  const byKey = new Map(plan.shifts.map((s) => [s.key, s]));
  const days = plan.crews[0]?.cycleLengthDays ?? 0;
  return (
    <div className="max-w-full overflow-x-auto" data-testid="crew-cycle">
      <table className="border-separate border-spacing-1 text-[11px]" aria-label={t('rtc.cycleTitle')}>
        <thead>
          <tr>
            <th scope="col" className="text-start text-xs font-medium text-muted-foreground">{t('rtc.crew')}</th>
            {Array.from({ length: days }, (_, d) => <th key={d} scope="col" className="w-7 text-center font-normal text-muted-foreground tnum">{d + 1}</th>)}
          </tr>
        </thead>
        <tbody>
          {plan.crews.map((c) => (
            <tr key={c.crew}>
              <th scope="row" className="whitespace-nowrap pe-2 text-start text-xs font-medium">{t('rtc.crewName', { crew: c.crew })}</th>
              {c.sequence.map((e) => {
                const shift = 'shiftKey' in e ? byKey.get(e.shiftKey) : undefined;
                const label = t('rtc.cellLabel', { crew: c.crew, day: e.day + 1, what: shift ? shift.name : t('rtc.off') });
                return (
                  <td key={e.day} title={label} aria-label={label} className={cn('h-7 w-7 rounded text-center font-semibold', shift ? 'text-white' : 'bg-muted text-muted-foreground')} style={shift ? { backgroundColor: shift.color } : undefined}>
                    {shift ? shift.key : '·'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
