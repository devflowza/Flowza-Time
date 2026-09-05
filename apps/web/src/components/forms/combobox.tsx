import * as React from 'react';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Loader2, X } from 'lucide-react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface ComboboxOption { value: string; label: string; description?: string; disabled?: boolean }

interface ComboboxProps {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  options: ComboboxOption[];
  placeholder?: string;
  /** Server-side search callback (debounced by the caller). */
  onSearch?: (query: string) => void;
  loading?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  emptyText?: string;
  'aria-invalid'?: boolean;
}

/** Accessible searchable select (branches, departments, employees…). Options are provided by the caller (server-side search supported). */
export function Combobox({ value, onChange, options, placeholder, onSearch, loading, clearable, disabled, id, className, emptyText, ...rest }: ComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button id={id} type="button" role="combobox" aria-expanded={open} aria-invalid={rest['aria-invalid']} disabled={disabled} className={cn('flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 aria-invalid:border-destructive', !selected && 'text-muted-foreground', className)}>
          <span className="truncate">{selected?.label ?? placeholder ?? t('common.none')}</span>
          <span className="flex items-center gap-1">
            {clearable && selected ? <X className="size-3.5 opacity-60 hover:opacity-100" onClick={(e) => { e.stopPropagation(); onChange(null); }} aria-label="Clear" /> : null}
            <ChevronsUpDown className="size-4 opacity-50" />
          </span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content align="start" sideOffset={4} className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[220px] rounded-md border bg-card p-0 text-card-foreground shadow-md">
          <Command shouldFilter={!onSearch} className="flex flex-col">
            <div className="flex items-center gap-2 border-b px-3">
              <Command.Input placeholder={t('common.searchPlaceholder')} onValueChange={(q) => onSearch?.(q)} className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
              {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
            </div>
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText ?? t('common.noResults')}</Command.Empty>
              {options.map((o) => (
                <Command.Item key={o.value} value={o.label + ' ' + o.value} disabled={o.disabled} onSelect={() => { onChange(o.value); setOpen(false); }} className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[disabled=true]:opacity-50">
                  <Check className={cn('size-4', o.value === value ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.description ? <span className="truncate text-xs text-muted-foreground">{o.description}</span> : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
