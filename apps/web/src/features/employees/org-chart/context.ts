import { createContext, useContext, useEffect } from 'react';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import type { ManagerLine, OrgChartFilter, OrgChartNodeDto } from '@flowza/contracts';
import { levelNodes, type OrgChartLevelPage } from './api';

/**
 * The person the chart is focused on: the cards from the top of the chart down to them (`path`; empty when they are in the
 * Unassigned panel, which then lists them under `search`). Every "find" is a new `nonce`, landed once (see `claimFocus`).
 */
export interface OrgChartFocus { id: string; path: string[]; nonce: number; search?: string }
/** What is being dragged: a card of the chart or a row of the Unassigned panel. */
export interface OrgChartDragItem { id: string; name: string; managerEmployeeId: string | null }
export interface PersonRef { id: string; name: string }

/** The dialogs a card, a row or a drop can open (one at a time, owned by the page). */
export type OrgChartEdit =
  | {
    kind: 'assign'; employeeIds: string[]; subjectName?: string; currentManagerName?: string | null; line: ManagerLine; onDone?: () => void;
    /** How many of them report to a manager outside this view of the chart (that line is replaced: the dialog says so). */
    outsideManagerCount?: number;
  }
  | { kind: 'addReports'; manager: PersonRef }
  | { kind: 'remove'; employee: PersonRef; line: ManagerLine; managerName: string | null }
  /** `currentManagerName`: the dragged person's manager when the chart shows them (null: none, or outside this view). */
  | { kind: 'move'; employee: OrgChartDragItem; manager: PersonRef; currentManagerName: string | null };

export interface OrgChartContextValue {
  filters: OrgChartFilter;
  /** employee.update: menus, drag-and-drop and the Unassigned bulk action. */
  canEdit: boolean;
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  focus: OrgChartFocus | null;
  /**
   * The card or Unassigned row showing the focused person calls this before scrolling to it and moving keyboard focus there:
   * true for the first claim of a `nonce` only. A remount — a team collapsed and opened again, a filter change, a new search
   * in the panel — must not pull the viewport or the keyboard away from what the reader is doing (WCAG 3.2.1 / 3.2.2).
   */
  claimFocus: (nonce: number) => boolean;
  /** The focus request whose landing glow plays (cleared by `endGlow` when the animation ends, so a remount does not replay it). */
  glow: number | null;
  endGlow: (nonce: number) => void;
  dragging: OrgChartDragItem | null;
  startDrag: (item: OrgChartDragItem) => void;
  endDrag: () => void;
  /** Whether the dragged person may be dropped on `targetId` (not themselves, not somebody in their loaded team). */
  canDropOn: (targetId: string) => boolean;
  dropOn: (target: PersonRef) => void;
  edit: (edit: OrgChartEdit) => void;
  /** The employee's name in the UI language (the Arabic display name in Arabic, when there is one). */
  nameOf: (node: Pick<OrgChartNodeDto, 'displayName' | 'displayNameAr'>) => string;
  /** The name of a loaded card's manager, when the chart has loaded that manager. */
  managerNameOf: (node: Pick<OrgChartNodeDto, 'managerEmployeeId'>) => string | null;
}

export const OrgChartContext = createContext<OrgChartContextValue | null>(null);

export function useOrgChart(): OrgChartContextValue {
  const ctx = useContext(OrgChartContext);
  if (!ctx) throw new Error('useOrgChart outside the org chart');
  return ctx;
}

/** The id of the focus path expected on the level below `parentId` (null = the heads of the chart). */
export function wantedOnLevel(focus: OrgChartFocus | null, parentId: string | null): string | undefined {
  if (!focus) return undefined;
  if (parentId === null) return focus.path[0];
  const at = focus.path.indexOf(parentId);
  return at >= 0 ? focus.path[at + 1] : undefined;
}

/**
 * Focusing somebody behind "Show more" (a team of more than one page): load the level's next pages until the next card of
 * the focus path is there, so the chart can open the way down to them.
 */
export function useLoadUntilFound(q: UseInfiniteQueryResult<InfiniteData<OrgChartLevelPage>>, wanted: string | undefined): void {
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    if (!wanted || !data || !hasNextPage || isFetchingNextPage) return;
    if (levelNodes(data).some((n) => n.id === wanted)) return;
    void fetchNextPage();
  }, [wanted, data, hasNextPage, isFetchingNextPage, fetchNextPage]);
}
