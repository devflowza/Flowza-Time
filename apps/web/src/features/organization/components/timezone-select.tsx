import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';

import { GCC_TIMEZONES } from '../timezones';
const FALLBACK_ZONES = ['UTC', 'Asia/Baghdad', 'Asia/Amman', 'Asia/Beirut', 'Africa/Cairo', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Manila', 'Asia/Jakarta', 'Europe/London', 'Europe/Paris', 'Europe/Istanbul', 'America/New_York', 'America/Los_Angeles'];

function allZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const list = intl.supportedValuesOf?.('timeZone');
    if (list && list.length > 0) return list;
  } catch { /* older browsers */ }
  return FALLBACK_ZONES;
}

export function TimezoneSelect({ id, value, onChange, disabled, 'aria-invalid': invalid }: { id?: string; value: string | undefined; onChange: (tz: string) => void; disabled?: boolean; 'aria-invalid'?: boolean }) {
  const { t } = useTranslation('organization');
  const others = useMemo(() => {
    const gcc = new Set<string>(GCC_TIMEZONES);
    const zones = allZones().filter((z) => !gcc.has(z));
    if (value && !gcc.has(value) && !zones.includes(value)) zones.unshift(value);
    return zones;
  }, [value]);
  return (
    <Select value={value ?? ''} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-invalid={invalid} dir="ltr" className="font-mono text-xs"><SelectValue placeholder={t('branches.timezonePlaceholder')} /></SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <div className="px-2 py-1 text-[11px] font-semibold uppercase text-muted-foreground">{t('branches.gccZones')}</div>
          {GCC_TIMEZONES.map((z) => <SelectItem key={z} value={z} dir="ltr">{z}</SelectItem>)}
        </SelectGroup>
        <SelectGroup>
          <div className="px-2 py-1 text-[11px] font-semibold uppercase text-muted-foreground">{t('branches.otherZones')}</div>
          {others.map((z) => <SelectItem key={z} value={z} dir="ltr">{z}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
