import { useState, type DragEvent } from 'react';
import { useOrgChart, type OrgChartDragItem, type PersonRef } from './context';

/** The drag payload type (the person's id); `text/plain` carries the name for drops outside the app. */
const DRAG_TYPE = 'application/x-flowza-employee';

/**
 * A card or an Unassigned row that can be dragged onto a new manager (native HTML5 drag-and-drop). The dragged person lives in
 * the chart's context, because a `dragover` handler cannot read the payload. Dragging is never the only way: every move is
 * also in the card menu and the Unassigned panel's bulk action.
 */
export function useDragSource(item: OrgChartDragItem) {
  const ctx = useOrgChart();
  if (!ctx.canEdit) return {};
  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.setData(DRAG_TYPE, item.id);
        e.dataTransfer.setData('text/plain', item.name);
        e.dataTransfer.effectAllowed = 'move';
      }
      ctx.startDrag(item);
    },
    onDragEnd: () => ctx.endDrag(),
  };
}

/**
 * A person somebody can be dropped on (they become the dragged person's line manager, after a confirmation). Drops on the
 * dragged person themselves or on their own team are accepted by the browser but refused by the chart with a toast, so the
 * reader learns why; the highlight already says so while hovering.
 */
export function useDropTarget(target: PersonRef) {
  const ctx = useOrgChart();
  const [over, setOver] = useState<{ item: OrgChartDragItem; ok: boolean } | null>(null);
  // only the drag that is in progress highlights (a cancelled drag never leaves a stale outline behind)
  const state = over && ctx.dragging && over.item === ctx.dragging ? (over.ok ? 'valid' : 'invalid') : null;
  if (!ctx.canEdit) return { state: null, props: {} };
  return {
    state,
    props: {
      onDragEnter: (e: DragEvent<HTMLElement>) => {
        if (!ctx.dragging) return;
        e.preventDefault();
        setOver({ item: ctx.dragging, ok: ctx.canDropOn(target.id) });
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!ctx.dragging) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOver(null);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        if (!ctx.dragging) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(null);
        ctx.dropOn(target);
      },
    },
  };
}
