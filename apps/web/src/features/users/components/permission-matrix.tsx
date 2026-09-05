import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import type { Permission, PermissionDto } from '@flowza/contracts';
import { Checkbox, Label, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { cn } from '@/lib/utils';

export interface PermissionMatrixProps {
  permissions: PermissionDto[];
  value: string[];
  onChange?: (next: Permission[]) => void;
  readOnly?: boolean;
  /** Permissions the current user holds; others are shown but cannot be granted (server + DB trigger enforce this too). */
  grantable?: ReadonlySet<string>;
}

/** Permission checkboxes grouped by category with a per-group toggle. Keyboard accessible (native checkbox semantics via Radix). */
export function PermissionMatrix({ permissions, value, onChange, readOnly, grantable }: PermissionMatrixProps) {
  const { t } = useTranslation('users');
  const selected = useMemo(() => new Set(value), [value]);
  const groups = useMemo(() => {
    const map = new Map<string, PermissionDto[]>();
    for (const p of [...permissions].sort((a, b) => a.sortOrder - b.sortOrder)) { const list = map.get(p.category) ?? []; list.push(p); map.set(p.category, list); }
    return [...map.entries()];
  }, [permissions]);
  const canGrant = (key: string) => !readOnly && !!onChange && (!grantable || grantable.has(key));
  const set = (keys: Permission[], on: boolean) => {
    if (!onChange) return;
    const next = new Set(selected);
    for (const k of keys) { if (!canGrant(k)) continue; if (on) next.add(k); else next.delete(k); }
    onChange([...next] as Permission[]);
  };

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {groups.map(([category, perms]) => {
        const grantableKeys = perms.filter((p) => canGrant(p.key)).map((p) => p.key);
        const checkedCount = perms.filter((p) => selected.has(p.key)).length;
        const groupState = checkedCount === 0 ? false : checkedCount === perms.length ? true : 'indeterminate';
        return (
          <fieldset key={category} className="rounded-lg border bg-card p-3 shadow-card">
            <legend className="sr-only">{t(`categories.${category}`, { defaultValue: category })}</legend>
            <div className="mb-2 flex items-center gap-2 border-b pb-2">
              <Checkbox id={`grp-${category}`} checked={groupState} disabled={grantableKeys.length === 0} onCheckedChange={(v) => set(grantableKeys, !!v)} aria-label={t('roles.toggleGroup', { group: category })} />
              <Label htmlFor={`grp-${category}`} className="text-sm font-semibold capitalize">{t(`categories.${category}`, { defaultValue: category })}</Label>
              <span className="ms-auto text-xs text-muted-foreground tnum">{checkedCount}/{perms.length}</span>
            </div>
            <ul className="space-y-1.5">
              {perms.map((p) => {
                const allowed = canGrant(p.key);
                const locked = !readOnly && !!grantable && !grantable.has(p.key);
                return (
                  <li key={p.key} className={cn('flex items-start gap-2 rounded-md px-1 py-1', !allowed && 'opacity-70')}>
                    <Checkbox id={`perm-${p.key}`} checked={selected.has(p.key)} disabled={!allowed} onCheckedChange={(v) => set([p.key], !!v)} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <Label htmlFor={`perm-${p.key}`} className={cn('flex items-center gap-1 font-mono text-xs', !allowed && 'cursor-not-allowed')} dir="ltr">
                        {p.key}
                        {locked ? <Tooltip><TooltipTrigger asChild><Lock className="size-3 text-muted-foreground" aria-label={t('roles.notHeld')} /></TooltipTrigger><TooltipContent>{t('roles.notHeld')}</TooltipContent></Tooltip> : null}
                      </Label>
                      <p className="text-xs text-muted-foreground">{p.description}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}
