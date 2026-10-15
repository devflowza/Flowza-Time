import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { useEmployee, useEmployeeOptions } from '@/features/employees/api';
import { MEETINGS_NS } from '../i18n';

interface ChipPickerProps {
  id: string;
  values: string[];
  onChange: (next: string[]) => void;
  options: ComboboxOption[];
  placeholder: string;
  /** Accessible name of the list of chosen values. */
  listLabel: string;
  onSearch?: (q: string) => void;
  loading?: boolean;
  disabled?: boolean;
  /** How a chosen value that is not among the options is named (e.g. fetched one by one). */
  renderUnknown?: (value: string) => React.ReactNode;
  /** Labels remembered for values that left the options (a server-side search moved on). */
  labels?: Record<string, string>;
  onPicked?: (option: ComboboxOption) => void;
}

/** A searchable select that accumulates its picks as removable chips (allowed departments / employees of a room). */
export function ChipPicker({ id, values, onChange, options, placeholder, listLabel, onSearch, loading, disabled, renderUnknown, labels, onPicked }: ChipPickerProps) {
  const { t } = useTranslation(MEETINGS_NS);
  const byValue = new Map(options.map((o) => [o.value, o.label]));
  const nameOf = (v: string) => byValue.get(v) ?? labels?.[v];
  const add = (v: string | null) => {
    if (!v || values.includes(v)) return;
    const option = options.find((o) => o.value === v);
    if (option) onPicked?.(option);
    onChange([...values, v]);
  };
  return (
    <div className="space-y-2">
      <Combobox id={id} value={null} onChange={add} options={options.filter((o) => !values.includes(o.value))} onSearch={onSearch} loading={loading} disabled={disabled} placeholder={placeholder} />
      {values.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={listLabel}>
          {values.map((v) => {
            const name = nameOf(v);
            return (
              <li key={v}>
                <Badge variant="secondary" className="gap-1 pe-1">
                  <span className="max-w-[180px] truncate">{name ?? renderUnknown?.(v) ?? v.slice(0, 8)}</span>
                  <button type="button" className="rounded-full p-0.5 hover:bg-foreground/10 disabled:opacity-50" aria-label={t('form.remove', { name: name ?? v.slice(0, 8) })} disabled={disabled} onClick={() => onChange(values.filter((x) => x !== v))}><X className="size-3" /></button>
                </Badge>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** An employee's display name, fetched when no list on screen carries it (a room's allowed employees). */
function EmployeeName({ id }: { id: string }) {
  const q = useEmployee(id);
  return <>{q.data?.displayName ?? id.slice(0, 8)}</>;
}

/** Server-searched employee chips; names of employees chosen earlier are looked up one by one. */
export function EmployeeChipPicker({ id, value, onChange, placeholder, listLabel, disabled }: { id: string; value: string[]; onChange: (ids: string[]) => void; placeholder: string; listLabel: string; disabled?: boolean }) {
  const employees = useEmployeeOptions();
  const [labels, setLabels] = useState<Record<string, string>>({});
  return (
    <ChipPicker
      id={id} values={value} onChange={onChange} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} disabled={disabled}
      placeholder={placeholder} listLabel={listLabel} labels={labels} onPicked={(o) => setLabels((l) => ({ ...l, [o.value]: o.label }))}
      renderUnknown={(v) => <EmployeeName id={v} />}
    />
  );
}
