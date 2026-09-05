import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useEmployeeOptions } from '@/features/employees/api';

/** Server-searched employee picker that accumulates selections as removable chips (labels are cached locally). */
export function EmployeeMultiSelect({ id, value, onChange, disabled, max = 1000 }: { id?: string; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean; max?: number }) {
  const { t } = useTranslation('attendance');
  const employees = useEmployeeOptions();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const add = (v: string | null) => {
    if (!v || value.includes(v) || value.length >= max) return;
    const opt = employees.options.find((o) => o.value === v);
    if (opt) setLabels((l) => ({ ...l, [v]: opt.label }));
    onChange([...value, v]);
  };
  return (
    <div className="space-y-2">
      <Combobox id={id} value={null} onChange={add} options={employees.options.filter((o) => !value.includes(o.value))} onSearch={employees.setSearch} loading={employees.isLoading} disabled={disabled || value.length >= max} placeholder={t('multi.addEmployee')} />
      {value.length ? (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label={t('multi.selected', { count: value.length })}>
          {value.map((id) => (
            <Badge key={id} variant="secondary" role="listitem" className="gap-1 pe-1">
              <span className="max-w-[160px] truncate">{labels[id] ?? id.slice(0, 8)}</span>
              <button type="button" className="rounded-full p-0.5 hover:bg-foreground/10" aria-label={t('multi.remove', { name: labels[id] ?? id })} disabled={disabled} onClick={() => onChange(value.filter((x) => x !== id))}><X className="size-3" /></button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
