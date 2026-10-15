import { useTranslation } from 'react-i18next';
import { DEVICE_PUNCH_ROLES, type DevicePunchRole } from '@flowza/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';

/**
 * What a terminal's punches mean (docs/time-away.md): AUTO keeps the direction the terminal reports, CHECK_IN / CHECK_OUT make
 * every punch an arrival / a departure, ACCESS makes it a door or meeting-room reader (room access, never attendance). The
 * caller shows `punchRole.descriptions.<role>` of the chosen role as the field's hint.
 */
export function PunchRoleSelect({ id, value, onChange, disabled }: { id: string; value: DevicePunchRole; onChange: (role: DevicePunchRole) => void; disabled?: boolean }) {
  const { t } = useTranslation('devices');
  return (
    <Select value={value} onValueChange={(v) => onChange(v as DevicePunchRole)} disabled={disabled}>
      <SelectTrigger id={id} aria-describedby={`${id}-hint`}><SelectValue /></SelectTrigger>
      <SelectContent>{DEVICE_PUNCH_ROLES.map((r) => <SelectItem key={r} value={r}>{t(`punchRole.options.${r}`)}</SelectItem>)}</SelectContent>
    </Select>
  );
}
