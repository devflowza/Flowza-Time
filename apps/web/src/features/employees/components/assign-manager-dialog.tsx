import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, TriangleAlert } from 'lucide-react';
import { MANAGER_LINES, type ManagerLine } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeOptions } from '../api';
import { LEFT_EMPLOYMENT, useAssignManager } from '../org-chart/use-assign-manager';

interface AssignManagerDialogProps {
  /** The employees whose manager changes (one from a card, many from the list or the Unassigned panel). */
  employeeIds: string[];
  /** The name of the one employee being edited, for the title; omitted in bulk. */
  subjectName?: string | null;
  /** Their current line manager, shown as a reminder ("Currently reports to …"). */
  currentManagerName?: string | null;
  defaultLine?: ManagerLine;
  /**
   * How many of them report to a manager the org chart's current view does not show (another branch or department, or
   * outside the reader's branch scope): a new line manager replaces that reporting line, so the dialog says so.
   */
  outsideManagerCount?: number;
  onClose: () => void;
  onDone?: () => void;
}

/**
 * Assign a manager to one or many employees — the line manager (solid line: team visibility, approvals, the org chart;
 * effective-dated) or the secondary, dotted-line manager (backup approver; changes at once). Removing the manager is a
 * deliberate choice (a checkbox), never an empty picker submitted by accident. Plain state rather than a form library,
 * like the other bulk dialogs (the React Compiler leaves react-hook-form modules alone).
 */
export function AssignManagerDialog({ employeeIds, subjectName, currentManagerName, defaultLine = 'primary', outsideManagerCount = 0, onClose, onDone }: AssignManagerDialogProps) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const { assign, isPending } = useAssignManager();
  const managers = useEmployeeOptions();
  const [picked, setPicked] = useState<ComboboxOption | null>(null);
  const [remove, setRemove] = useState(false);
  const [line, setLine] = useState<ManagerLine>(defaultLine);
  const [effectiveFrom, setEffectiveFrom] = useState(() => todayIso(tz));
  const count = employeeIds.length;
  const excluded = new Set(employeeIds);

  // the people being edited cannot manage themselves, and nobody who left can manage anyone
  const found: ComboboxOption[] = managers.data
    .filter((e) => !excluded.has(e.id) && !LEFT_EMPLOYMENT.includes(e.employmentStatus))
    .map((e) => ({ value: e.id, label: e.displayName, description: e.employeeNumber }));
  // keep the chosen manager listed (and labelled) while the search moves on to other names
  const options = picked && !found.some((o) => o.value === picked.value) ? [picked, ...found] : found;

  const title = subjectName
    ? t(line === 'secondary' ? 'assignManager.titleSecondaryOne' : 'assignManager.titleOne', { name: subjectName })
    : t('bulk.assign_manager.title', { count });
  // null = remove the manager (only when asked for explicitly); undefined = nothing chosen yet
  const managerEmployeeId = remove ? null : picked?.value;
  const ready = managerEmployeeId !== undefined;
  const submit = () => {
    if (managerEmployeeId === undefined) return;
    assign({ employeeIds, managerEmployeeId, line, ...(line === 'primary' && effectiveFrom ? { effectiveFrom } : {}) }, () => { onDone?.(); onClose(); });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('assignManager.hint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {currentManagerName ? <p className="text-sm text-muted-foreground">{t('assignManager.currentManager', { name: currentManagerName })}</p> : null}
          {outsideManagerCount > 0 && line === 'primary' ? (
            <p role="note" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <span>{t('assignManager.replacesOutside', { count: outsideManagerCount })}</span>
            </p>
          ) : null}

          <fieldset className="space-y-2">
            <legend id="assign-manager-line-label" className="mb-2 text-sm font-medium">{t('assignManager.line')}</legend>
            <div role="radiogroup" aria-labelledby="assign-manager-line-label" className="grid gap-2 sm:grid-cols-2">
              {MANAGER_LINES.map((l) => (
                <label key={l} className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', line === l ? 'border-brand-500 bg-accent/50' : 'hover:border-brand-300')}>
                  <input type="radio" name="assign-manager-line" value={l} checked={line === l} onChange={() => setLine(l)} className="mt-0.5 accent-brand-600" />
                  <span className="min-w-0">
                    <span className="block font-medium">{t(`assignManager.lines.${l}`)}</span>
                    <span className="block text-xs text-muted-foreground">{t(`assignManager.lines.${l}Hint`)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <FormField label={line === 'secondary' ? t('assignManager.secondaryManager') : t('assignManager.manager')} htmlFor="assign-manager" required={!remove}>
            <Combobox id="assign-manager" value={remove ? null : (picked?.value ?? null)} onChange={(v) => setPicked(v ? (options.find((o) => o.value === v) ?? null) : null)}
              options={options} onSearch={managers.setSearch} loading={managers.isLoading} disabled={remove} clearable placeholder={t('assignManager.pick')} emptyText={tc('common.noResults')} />
          </FormField>

          <div className="flex items-start gap-2">
            <Checkbox id="assign-manager-remove" checked={remove} onCheckedChange={(v) => setRemove(v === true)} className="mt-0.5" />
            <div className="space-y-1">
              <Label htmlFor="assign-manager-remove">{t(line === 'secondary' ? 'assignManager.removeSecondary' : 'assignManager.remove')}</Label>
              {remove ? <p className="text-xs text-muted-foreground">{t(line === 'secondary' ? 'assignManager.removeSecondaryHint' : 'assignManager.removeHint')}</p> : null}
            </div>
          </div>

          {line === 'primary' ? (
            <FormField label={t('effective.effectiveFrom')} htmlFor="assign-manager-from" hint={t('assignManager.effectiveHint')}>
              <Input id="assign-manager-from" type="date" dir="ltr" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </FormField>
          ) : null}

          <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{line === 'primary' ? t('assignManager.promoteHint') : t('assignManager.secondaryNow')}</span>
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" variant={remove ? 'destructive' : 'default'} loading={isPending} disabled={!ready} onClick={submit}>
            {remove ? t('assignManager.submitRemove') : subjectName ? t('assignManager.submit') : t('bulk.apply', { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
