import { useCallback, useState } from 'react';
import { useCan } from '@/features/me/use-me';
import type { DayRef } from './record-dialog';
import { RecordEditDialog, type RecordEditPreset } from './record-edit-dialog';
import { TimelineDrawer } from './timeline-drawer';

/** HR's Add / Edit record: files corrections, applies them (attendance.approve) and reads the org-wide register (attendance.view). */
export const HR_EDIT_PERMISSIONS = ['attendance.view', 'attendance.correct', 'attendance.approve'] as const;

/**
 * The punch timeline drawer and the Add / Edit record dialog, shared by the daily, monthly and calendar views (HR portal
 * Prompt 6a). `openEdit` is undefined for a member who may not edit records, so a view simply hides its edit affordances.
 */
export function useWorkspaceDialogs() {
  const can = useCan();
  const canEdit = can(...HR_EDIT_PERMISSIONS);
  const [timeline, setTimeline] = useState<DayRef | null>(null);
  const [edit, setEdit] = useState<{ open: boolean; preset?: RecordEditPreset; key: number }>({ open: false, key: 0 });
  const openTimeline = useCallback((day: DayRef) => setTimeline(day), []);
  const openEditDialog = useCallback((preset?: RecordEditPreset) => setEdit((e) => ({ open: true, preset, key: e.key + 1 })), []);
  const dialogs = (
    <>
      <TimelineDrawer day={timeline} onClose={() => setTimeline(null)} onEdit={canEdit ? (d) => { setTimeline(null); openEditDialog({ employeeId: d.employeeId, employeeName: d.employeeName, date: d.date }); } : undefined} />
      {/* keyed per open so every Add / Edit starts from the day as the engine sees it now */}
      {edit.open ? <RecordEditDialog key={edit.key} open onOpenChange={(o) => setEdit((e) => ({ ...e, open: o }))} preset={edit.preset} /> : null}
    </>
  );
  return { canEdit, openTimeline, openEdit: canEdit ? openEditDialog : undefined, dialogs };
}
