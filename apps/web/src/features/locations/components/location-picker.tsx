import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocationDto, LocationLevelRole } from '@flowza/contracts';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { LOCATIONS_NS } from '../locale';
import { useLocationTree } from '../use-location-tree';
import { depthFirst, placesOfBranch } from '../tree';

export interface LocationPickerProps {
  value: string | null | undefined;
  /** The node comes along so callers can read its role / branch. */
  onChange: (locationId: string | null, node?: LocationDto) => void;
  /** Which kinds of node may be picked (default: any). */
  roles?: readonly LocationLevelRole[];
  /**
   * Only the places of this branch (a device's, an employee's, a fence's location). Without a branch nothing can be picked
   * when `roles` is `['place']`.
   */
  branchId?: string | null;
  /** Show archived locations too (only to keep an archived value readable). */
  includeArchived?: boolean;
  /** A further restriction on the nodes offered (e.g. the valid new parents of a move); applied after `roles` / `branchId`. */
  filter?: (node: LocationDto) => boolean;
  /** Replaces the default "nothing to pick" text (e.g. why a move has no possible target). */
  emptyText?: string;
  id?: string;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-invalid'?: boolean;
}

/**
 * A searchable, indented location select (docs/locations.md). Each row shows the location's name and its level ("Site",
 * "Floor"…); the search also matches the path ("Muscat HQ › Branch 1 › Site A"). The organisation's own level names are used
 * throughout.
 */
export function LocationPicker({ value, onChange, roles, branchId, includeArchived, filter, emptyText, id, placeholder, clearable = true, disabled, className, ...rest }: LocationPickerProps) {
  const { t } = useTranslation(LOCATIONS_NS);
  const tree = useLocationTree({ includeArchived });
  const placesOnly = roles?.length === 1 && roles[0] === 'place';

  const options = useMemo<ComboboxOption[]>(() => {
    const rows = (branchId !== undefined && placesOnly
      ? (branchId ? placesOfBranch(tree, branchId) : [])
      : depthFirst(tree).filter((r) => !roles || roles.includes(r.node.role))
    ).filter((r) => !filter || filter(r.node));
    // indent relative to the shallowest row shown, so a filtered list starts flush
    const base = rows.reduce((m, r) => Math.min(m, r.depth), Number.POSITIVE_INFINITY);
    const out: ComboboxOption[] = rows.map((r) => ({
      value: r.node.id,
      label: tree.nameOf(r.node),
      description: tree.levelName(r.node.levelId),
      depth: r.depth - (Number.isFinite(base) ? base : 0),
      keywords: [tree.labelOf(r.node.id), r.node.code],
      disabled: r.node.status === 'archived',
    }));
    // a value outside the list (archived, or of another branch) still shows its name
    if (value && !out.some((o) => o.value === value)) {
      const node = tree.byId.get(value);
      if (node) out.unshift({ value: node.id, label: tree.nameOf(node), description: tree.levelName(node.levelId), disabled: true });
    }
    return out;
  }, [tree, roles, branchId, placesOnly, filter, value]);

  const empty = emptyText ?? (placesOnly
    ? (branchId ? t('picker.noPlaces') : t('picker.chooseBranchFirst'))
    : roles?.length === 1 && roles[0] === 'group' ? t('picker.noGroups') : t('picker.none'));
  return (
    <Combobox
      id={id}
      value={value}
      onChange={(v) => onChange(v, v ? tree.byId.get(v) : undefined)}
      options={options}
      loading={tree.isLoading}
      clearable={clearable}
      disabled={disabled}
      className={className}
      placeholder={placeholder ?? (placesOnly ? t('picker.placeholderPlace') : t('picker.placeholder'))}
      emptyText={empty}
      aria-invalid={rest['aria-invalid']}
    />
  );
}
