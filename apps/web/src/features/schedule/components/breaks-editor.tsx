import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import type { ShiftBreak } from '@flowza/contracts';
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';

type Mode = 'window' | 'duration';
const modeOf = (b: ShiftBreak): Mode => ('minutes' in b ? 'duration' : 'window');

/** Shift breaks: fixed time windows (start–end) or floating durations (minutes), paid or unpaid. Max 6 (schema). */
export function BreaksEditor({ value, onChange, idPrefix = 'brk', max = 6 }: { value: ShiftBreak[]; onChange: (v: ShiftBreak[]) => void; idPrefix?: string; max?: number }) {
  const { t } = useTranslation('schedule');
  const update = (i: number, next: ShiftBreak) => onChange(value.map((b, j) => (j === i ? next : b)));
  const setMode = (i: number, mode: Mode) => { const paid = value[i]?.paid ?? false; update(i, mode === 'duration' ? { minutes: 30, paid } : { start: '12:00', end: '13:00', paid }); };
  return (
    <div className="space-y-2">
      {value.length === 0 ? <p className="text-xs text-muted-foreground">{t('shifts.noBreaks')}</p> : null}
      <ul className="space-y-2">
        {value.map((b, i) => {
          const mode = modeOf(b);
          return (
            <li key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[140px_1fr_auto_auto] sm:items-end">
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-${i}-mode`} className="text-xs text-muted-foreground">{t('shifts.breakMode')}</Label>
                <Select value={mode} onValueChange={(v) => setMode(i, v as Mode)}>
                  <SelectTrigger id={`${idPrefix}-${i}-mode`} className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="window">{t('shifts.breakWindow')}</SelectItem><SelectItem value="duration">{t('shifts.breakDuration')}</SelectItem></SelectContent>
                </Select>
              </div>
              {mode === 'window' && 'start' in b ? (
                <div className="flex items-end gap-2">
                  <div className="space-y-1"><Label htmlFor={`${idPrefix}-${i}-start`} className="text-xs text-muted-foreground">{t('shifts.breakStart')}</Label><Input id={`${idPrefix}-${i}-start`} type="time" dir="ltr" className="h-8 w-28 tnum" value={b.start} onChange={(e) => update(i, { ...b, start: e.target.value })} /></div>
                  <div className="space-y-1"><Label htmlFor={`${idPrefix}-${i}-end`} className="text-xs text-muted-foreground">{t('shifts.breakEnd')}</Label><Input id={`${idPrefix}-${i}-end`} type="time" dir="ltr" className="h-8 w-28 tnum" value={b.end} onChange={(e) => update(i, { ...b, end: e.target.value })} /></div>
                </div>
              ) : 'minutes' in b ? (
                <div className="space-y-1"><Label htmlFor={`${idPrefix}-${i}-min`} className="text-xs text-muted-foreground">{t('shifts.breakMinutes')}</Label><Input id={`${idPrefix}-${i}-min`} type="number" min={1} max={480} dir="ltr" className="h-8 w-28 tnum" value={b.minutes} onChange={(e) => update(i, { ...b, minutes: Number(e.target.value) })} /></div>
              ) : null}
              <label className="flex items-center gap-2 text-xs sm:pb-1.5"><Switch checked={b.paid ?? false} onCheckedChange={(paid) => update(i, { ...b, paid })} aria-label={t('shifts.breakPaid')} /> {t('shifts.breakPaid')}</label>
              <Button type="button" variant="ghost" size="icon" className="size-8 text-destructive" aria-label={t('shifts.removeBreak')} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 /></Button>
            </li>
          );
        })}
      </ul>
      <Button type="button" variant="outline" size="sm" disabled={value.length >= max} onClick={() => onChange([...value, { start: '12:00', end: '13:00', paid: false }])}><Plus /> {t('shifts.addBreak')}</Button>
    </div>
  );
}
