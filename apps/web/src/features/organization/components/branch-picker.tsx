import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus } from 'lucide-react';
import type { BranchDto } from '@flowza/contracts';
import { Combobox, type ComboboxAction, type ComboboxOption } from '@/components/forms';
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
 * Branch select that can also *create and edit* branches.
 *
 * A freshly provisioned tenant has no branches, and branches are required to add an employee or a device — so the
 * first thing a new customer met was a picker that said "No results", with nothing to click and no hint that branches
 * live under Organisation. Anyone holding `branch.manage` now gets the full branch dialog from inside the picker:
 * "Add branch", and "Edit <branch>" once one is chosen, so a code or name typed wrong is corrected here rather than by
 * abandoning a half-filled form to go to Organisation → Branches. Everyone else at least gets told where branches
 * come from.
 */
export function BranchPicker({ value, onChange, id, placeholder, clearable, disabled, className, ...rest }: BranchPickerProps) {
  const { t } = useTranslation('organization');
  const canManage = useCan()('branch.manage');
  const orgTimezone = useOrgTimezone();
  const branches = useBranchOptions();
  /** `null` = closed; `{ branch: null }` = create; `{ branch }` = edit that one. */
  const [dialog, setDialog] = useState<{ branch: BranchDto | null } | null>(null);
  // The list query is invalidated on create, but a refetch is a round trip: keep the new branch on hand so the field
  // shows its name the moment the dialog closes instead of falling back to the placeholder.
  const [created, setCreated] = useState<BranchDto | null>(null);

  const byId = (id2: string): BranchDto | undefined => branches.byId.get(id2) ?? (created?.id === id2 ? created : undefined);
  const selected = value ? byId(value) : undefined;

  const options = useMemo<ComboboxOption[]>(() => {
    if (!created || branches.options.some((o) => o.value === created.id)) return branches.options;
    return [...branches.options, { value: created.id, label: created.name, description: created.code }];
  }, [branches.options, created]);

  const actions = useMemo<ComboboxAction[] | undefined>(() => {
    if (!canManage) return undefined;
    const rows: ComboboxAction[] = [{ key: 'add', label: t('branches.add'), icon: <Plus className="size-4" />, onSelect: () => setDialog({ branch: null }) }];
    if (selected) rows.push({ key: 'edit', label: t('branches.editNamed', { name: selected.name }), icon: <Pencil className="size-4" />, onSelect: () => setDialog({ branch: selected }) });
    return rows;
  }, [canManage, selected, t]);

  const noBranches = !branches.isLoading && options.length === 0;
  return (
    <>
      <Combobox
        id={id}
        value={value}
        onChange={(v) => onChange(v, v ? byId(v) : undefined)}
        options={options}
        loading={branches.isLoading}
        clearable={clearable}
        disabled={disabled}
        className={className}
        placeholder={placeholder ?? t('branches.select')}
        emptyText={noBranches ? (canManage ? t('branches.empty') : t('branches.emptyNoPermission')) : undefined}
        actions={actions}
        aria-invalid={rest['aria-invalid']}
      />
      {dialog ? (
        <BranchDialog
          key={dialog.branch?.id ?? 'new'} open onOpenChange={(o) => { if (!o) setDialog(null); }} branch={dialog.branch} orgTimezone={orgTimezone}
          onCreated={(b) => { setCreated(b); onChange(b.id, b); }}
        />
      ) : null}
    </>
  );
}
