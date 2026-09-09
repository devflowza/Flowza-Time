import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BranchDto } from '@flowza/contracts';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '../lookups';
import { BranchDialog } from './branch-dialog';

interface BranchPickerProps {
  value: string | null | undefined;
  /** The branch row comes along so callers can copy its timezone (devices) or react to the change. */
  onChange: (branchId: string | null, branch?: BranchDto) => void;
  id?: string;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-invalid'?: boolean;
}

/**
 * Branch select that can also *create* a branch.
 *
 * A freshly provisioned tenant has no branches, and branches are required to add an employee or a device — so the
 * first thing a new customer met was a picker that said "No results" with nothing to click and no hint that branches
 * live under Organisation. Anyone holding `branch.manage` now gets the full branch dialog from inside the picker and
 * the new branch selected on save; everyone else at least gets told where branches come from.
 */
export function BranchPicker({ value, onChange, id, placeholder, clearable, disabled, className, ...rest }: BranchPickerProps) {
  const { t } = useTranslation('organization');
  const canManage = useCan()('branch.manage');
  const orgTimezone = useOrgTimezone();
  const branches = useBranchOptions();
  const [creating, setCreating] = useState(false);
  // The list query is invalidated on create, but a refetch is a round trip: keep the new branch on hand so the field
  // shows its name the moment the dialog closes instead of falling back to the placeholder.
  const [created, setCreated] = useState<BranchDto | null>(null);

  const options = useMemo<ComboboxOption[]>(() => {
    if (!created || branches.options.some((o) => o.value === created.id)) return branches.options;
    return [...branches.options, { value: created.id, label: created.name, description: created.code }];
  }, [branches.options, created]);

  const noBranches = !branches.isLoading && options.length === 0;
  return (
    <>
      <Combobox
        id={id}
        value={value}
        onChange={(v) => onChange(v, v ? (branches.byId.get(v) ?? (created?.id === v ? created : undefined)) : undefined)}
        options={options}
        loading={branches.isLoading}
        clearable={clearable}
        disabled={disabled}
        className={className}
        placeholder={placeholder ?? t('branches.select')}
        emptyText={noBranches ? (canManage ? t('branches.empty') : t('branches.emptyNoPermission')) : undefined}
        createLabel={canManage ? t('branches.add') : undefined}
        onCreate={canManage ? () => setCreating(true) : undefined}
        aria-invalid={rest['aria-invalid']}
      />
      {creating ? (
        <BranchDialog open onOpenChange={setCreating} branch={null} orgTimezone={orgTimezone} onCreated={(b) => { setCreated(b); onChange(b.id, b); }} />
      ) : null}
    </>
  );
}
