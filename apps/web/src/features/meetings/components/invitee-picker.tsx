import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button, Checkbox, Label } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useEmployeeOptions } from '@/features/employees/api';
import { MEETINGS_NS } from '../i18n';

export interface Invitee { employeeId: string; name: string; number: string | null; required: boolean }

/** Server-searched employee picker for a meeting's invitees; each one can be marked optional (required by default). */
export function InviteePicker({ id, value, onChange, invalid }: { id: string; value: Invitee[]; onChange: (next: Invitee[]) => void; invalid?: boolean }) {
  const { t } = useTranslation(MEETINGS_NS);
  const employees = useEmployeeOptions();
  const chosen = new Set(value.map((i) => i.employeeId));
  const add = (employeeId: string | null) => {
    if (!employeeId || chosen.has(employeeId)) return;
    const option = employees.options.find((o) => o.value === employeeId);
    onChange([...value, { employeeId, name: option?.label ?? employeeId.slice(0, 8), number: option?.description ?? null, required: true }]);
  };
  const setRequired = (employeeId: string, required: boolean) => onChange(value.map((i) => (i.employeeId === employeeId ? { ...i, required } : i)));
  return (
    <div className="space-y-2">
      <Combobox id={id} value={null} onChange={add} options={employees.options.filter((o) => !chosen.has(o.value))} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('form.addInvitee')} aria-invalid={invalid} />
      {value.length ? (
        <ul className="max-h-60 divide-y overflow-y-auto rounded-md border" aria-label={t('form.invitees')} data-testid="invitee-list">
          {value.map((i) => (
            <li key={i.employeeId} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{i.name}</p>
                {i.number ? <p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{i.number}</p> : null}
              </div>
              <div className="flex items-center gap-1.5">
                <Checkbox id={`${id}-req-${i.employeeId}`} checked={i.required} onCheckedChange={(v) => setRequired(i.employeeId, v === true)} />
                <Label htmlFor={`${id}-req-${i.employeeId}`} className="text-xs font-normal">{t('form.required')}</Label>
              </div>
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('form.remove', { name: i.name })} onClick={() => onChange(value.filter((x) => x.employeeId !== i.employeeId))}><X /></Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
