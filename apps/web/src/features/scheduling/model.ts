import type { BranchDeploymentStatus, ShiftCoverageReportDto } from '@flowza/contracts';

/*
 * Display helpers of round-the-clock scheduling. The API is the authority (it refuses a combination that cannot be one day
 * with 422 and the dates); these only describe what the forms show before anything is sent.
 */

export const CREWS = ['A', 'B', 'C', 'D'] as const;
export type Crew = (typeof CREWS)[number];
/** Weekdays as the coverage targets store them (0 = Sunday). */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const toMinutes = (hhmm: string): number => { const [h, m] = hhmm.split(':'); return Number(h) * 60 + Number(m); };
const toHhmm = (minutes: number): string => { const m = ((minutes % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

export interface DayShift { id: string; type: string; startTime: string | null; endTime: string | null }
export type ComposedDay = { ok: true; start: string; end: string; gapMinutes: number; spanMinutes: number } | { ok: false; reason: 'SAME_SHIFT' | 'NOT_FIXED' | 'OVERLAP' | 'TOO_LONG' };

/** The day an additional shift makes with the employee's shift (the rules of packages/domain composeDoubleShift). */
export function composeDayPreview(primary: DayShift, extra: DayShift): ComposedDay {
  if (primary.id === extra.id) return { ok: false, reason: 'SAME_SHIFT' };
  const span = (s: DayShift) => {
    if (s.type !== 'FIXED' || !s.startTime || !s.endTime) return null;
    const start = toMinutes(s.startTime.slice(0, 5));
    let end = toMinutes(s.endTime.slice(0, 5));
    if (end <= start) end += 1440;
    return { start, end };
  };
  const p = span(primary); const a = span(extra);
  if (!p || !a) return { ok: false, reason: 'NOT_FIXED' };
  const [first, second] = a.start < p.start ? [a, p] : [p, a];
  if (first.end > second.start) return { ok: false, reason: 'OVERLAP' };
  if (second.end - first.start >= 1440) return { ok: false, reason: 'TOO_LONG' };
  return { ok: true, start: toHhmm(first.start), end: toHhmm(second.end), gapMinutes: second.start - first.end, spanMinutes: second.end - first.start };
}

/** Badge variant of a deployment status. */
export function deploymentTone(status: BranchDeploymentStatus): 'success' | 'info' | 'neutral' | 'secondary' {
  switch (status) {
    case 'active': return 'success';
    case 'scheduled': return 'info';
    case 'cancelled': return 'secondary';
    default: return 'neutral';
  }
}

/** The key of a coverage report cell: its shift and its place (none = the whole branch). */
export const coverageKey = (shiftId: string, locationId: string | null | undefined): string => `${shiftId}|${locationId ?? ''}`;

export interface CoverageColumn {
  key: string; shiftId: string;
  /** The place of the branch the target covers (null = the whole branch). */
  locationId: string | null;
  shift: ShiftCoverageReportDto['shifts'][number] | undefined;
  /** A branch-wide column of a shift that also has place columns (its heading then says "whole branch"). */
  besidePlaces: boolean;
}

/**
 * The columns of the coverage grid: one per (shift, place) the report has cells for, in the report's shift order, the
 * branch-wide column of a shift first and its places by path. A shift without any cell keeps its branch-wide column, so a
 * branch without place targets shows exactly one column per shift (the grid's look before places).
 */
export function coverageColumns(report: ShiftCoverageReportDto, placeLabel: (locationId: string) => string): CoverageColumn[] {
  const pairs = new Map<string, { shiftId: string; locationId: string | null }>();
  for (const d of report.days) for (const c of d.cells) {
    const key = coverageKey(c.shiftId, c.locationId);
    if (!pairs.has(key)) pairs.set(key, { shiftId: c.shiftId, locationId: c.locationId ?? null });
  }
  const covered = new Set([...pairs.values()].map((p) => p.shiftId));
  for (const s of report.shifts) if (!covered.has(s.id)) pairs.set(coverageKey(s.id, null), { shiftId: s.id, locationId: null });
  const order = new Map(report.shifts.map((s, i) => [s.id, i]));
  const shifts = new Map(report.shifts.map((s) => [s.id, s]));
  const withPlaces = new Set([...pairs.values()].filter((p) => p.locationId).map((p) => p.shiftId));
  const rank = (shiftId: string) => order.get(shiftId) ?? Number.MAX_SAFE_INTEGER;
  return [...pairs.entries()]
    .map(([key, p]) => ({ key, ...p, shift: shifts.get(p.shiftId), besidePlaces: !p.locationId && withPlaces.has(p.shiftId) }))
    .sort((a, b) => rank(a.shiftId) - rank(b.shiftId)
      || (a.locationId ? 1 : 0) - (b.locationId ? 1 : 0)
      || (a.locationId && b.locationId ? placeLabel(a.locationId).localeCompare(placeLabel(b.locationId)) : 0));
}
