import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { ConfirmDialog, FormField, Input } from '@/components/ui';
import { todayIso } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { AssignManagerDialog } from '../components/assign-manager-dialog';
import { AddReportsDialog } from './add-reports-dialog';
import { useAssignManager } from './use-assign-manager';
import type { OrgChartDragItem, OrgChartEdit, PersonRef } from './context';

/** The one dialog the chart has open: what a card menu item, an Unassigned bulk action or a drop asked for. */
export function OrgChartEditDialog({ edit, onClose }: { edit: OrgChartEdit; onClose: () => void }) {
  switch (edit.kind) {
    case 'assign':
      return <AssignManagerDialog employeeIds={edit.employeeIds} subjectName={edit.subjectName} currentManagerName={edit.currentManagerName} defaultLine={edit.line} outsideManagerCount={edit.outsideManagerCount} onClose={onClose} onDone={edit.onDone} />;
    case 'addReports':
      return <AddReportsDialog manager={edit.manager} onClose={onClose} />;
    case 'remove':
      return <RemoveManagerDialog employee={edit.employee} line={edit.line} managerName={edit.managerName} onClose={onClose} />;
    case 'move':
      return <MoveDialog employee={edit.employee} manager={edit.manager} currentManagerName={edit.currentManagerName} onClose={onClose} />;
  }
}

function EffectiveDate({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation('employees');
  return (
    <FormField label={t('effective.effectiveFrom')} htmlFor={id} hint={t('assignManager.effectiveHint')}>
      <Input id={id} type="date" dir="ltr" value={value} onChange={(e) => onChange(e.target.value)} />
    </FormField>
  );
}

/**
 * A drop of A on B: "Make A report to B?" with the effective date, then `assign_manager` for A. The line it replaces is
 * spelled out: A's current manager, or — for somebody listed under Unassigned whose manager is outside this view of the
 * chart (another branch or department) — a warning that that reporting line goes.
 */
function MoveDialog({ employee, manager, currentManagerName, onClose }: { employee: OrgChartDragItem; manager: PersonRef; currentManagerName: string | null; onClose: () => void }) {
  const { t } = useTranslation('employees');
  const tz = useOrgTimezone();
  const { assign, isPending } = useAssignManager();
  const [effectiveFrom, setEffectiveFrom] = useState(() => todayIso(tz));
  const outside = employee.managerEmployeeId !== null && !currentManagerName;
  return (
    <ConfirmDialog open onOpenChange={(o) => !o && onClose()} title={t('orgChart.move.title')} description={t('orgChart.move.description', { employee: employee.name, manager: manager.name })}
      confirmLabel={t('orgChart.move.confirm')} loading={isPending}
      onConfirm={() => assign({ employeeIds: [employee.id], managerEmployeeId: manager.id, line: 'primary', ...(effectiveFrom ? { effectiveFrom } : {}) }, onClose)}>
      <div className="space-y-3">
        {currentManagerName ? <p className="text-sm text-muted-foreground">{t('assignManager.currentManager', { name: currentManagerName })}</p> : null}
        {outside ? (
          <p role="note" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <span>{t('orgChart.move.outsideManager', { employee: employee.name })}</span>
          </p>
        ) : null}
        <EffectiveDate id="org-move-from" value={effectiveFrom} onChange={setEffectiveFrom} />
      </div>
    </ConfirmDialog>
  );
}

/** "Remove manager" / "Remove secondary manager" from a card: the line manager from a date, the dotted line at once. */
function RemoveManagerDialog({ employee, line, managerName, onClose }: { employee: PersonRef; line: 'primary' | 'secondary'; managerName: string | null; onClose: () => void }) {
  const { t } = useTranslation('employees');
  const tz = useOrgTimezone();
  const { assign, isPending } = useAssignManager();
  const [effectiveFrom, setEffectiveFrom] = useState(() => todayIso(tz));
  const primary = line === 'primary';
  return (
    <ConfirmDialog open onOpenChange={(o) => !o && onClose()} destructive loading={isPending}
      title={t(primary ? 'orgChart.remove.title' : 'orgChart.remove.titleSecondary', { name: employee.name })}
      description={primary ? t('orgChart.remove.description', { name: employee.name }) : t('orgChart.remove.descriptionSecondary', { name: employee.name, manager: managerName ?? '—' })}
      confirmLabel={t(primary ? 'orgChart.card.removeManager' : 'orgChart.card.removeSecondary')}
      onConfirm={() => assign({ employeeIds: [employee.id], managerEmployeeId: null, line, ...(primary && effectiveFrom ? { effectiveFrom } : {}) }, onClose)}>
      {primary ? <EffectiveDate id="org-remove-from" value={effectiveFrom} onChange={setEffectiveFrom} /> : null}
    </ConfirmDialog>
  );
}
