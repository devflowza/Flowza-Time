import { create } from 'zustand';

/**
 * Days whose record edit was just saved (2026-10-02 field report: "after Save the daily view shows Absent until the
 * recalculation finishes"). Saving files corrections and returns at once; the worker applies them and recalculates the day
 * within seconds. Until the day's record was computed after the edit was filed, the register says so ("Updating…") and polls
 * quickly instead of showing the old outcome as if it were the answer. In memory only: a reload simply shows the record.
 */
export const PENDING_EDIT_TIMEOUT_MS = 60_000;
export const PENDING_EDIT_POLL_MS = 2_000;

export const pendingEditKey = (employeeId: string, date: string): string => `${employeeId}|${date}`;

/** `filedAt`: server time the corrections were filed, compared with the record's server-side `computedAt`. */
export interface PendingEdit { filedAt: number; token: number }

interface PendingEditsState {
  edits: Record<string, PendingEdit>;
  mark: (employeeId: string, date: string, filedAt: string | undefined) => void;
  settle: (keys: readonly string[]) => void;
}

const without = (edits: Record<string, PendingEdit>, keys: readonly string[]): Record<string, PendingEdit> => {
  const next = { ...edits };
  for (const k of keys) delete next[k];
  return next;
};
let tokens = 0;

export const usePendingEdits = create<PendingEditsState>()((set) => ({
  edits: {},
  mark: (employeeId, date, filedAt) => {
    const key = pendingEditKey(employeeId, date);
    const token = ++tokens;
    const filed = filedAt ? Date.parse(filedAt) : Number.NaN;
    set((s) => ({ edits: { ...s.edits, [key]: { filedAt: Number.isFinite(filed) ? filed : Date.now(), token } } }));
    // gives up after PENDING_EDIT_TIMEOUT_MS (an approval workflow, a stopped worker): the register then shows what it has
    setTimeout(() => set((s) => (s.edits[key]?.token === token ? { edits: without(s.edits, [key]) } : s)), PENDING_EDIT_TIMEOUT_MS);
  },
  settle: (keys) => set((s) => (keys.some((k) => k in s.edits) ? { edits: without(s.edits, keys) } : s)),
}));

/** Whether the record on screen still predates the edit filed for its day: no record yet, or one computed before the edit. */
export function awaitsRecalculation(edit: PendingEdit | undefined, computedAt: string | null | undefined): boolean {
  if (!edit) return false;
  return !computedAt || Date.parse(computedAt) < edit.filedAt;
}
