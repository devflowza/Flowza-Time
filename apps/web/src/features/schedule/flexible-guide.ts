const hm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const toMin = (v: string | undefined | null) => (v && /^\d{2}:\d{2}/.test(v) ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) : null);

/**
 * The flexible shift's rule in the author's own numbers (mirrors the engine, @flowza/domain `buildSchedule`): the expected
 * check-out is the check-in + the required minutes + the unpaid breaks, and core hours longer than that make everyone stay until
 * the core end — worth a warning, since core hours are easily mistaken for "the hours in which people may check in".
 */
export function flexibleGuide(required: unknown, coreStart: string | undefined | null, coreEnd: string | undefined | null, breaks: unknown): { example: { in: string; out: string } | null; coreTooLong: { core: string; required: string } | null } {
  const req = typeof required === 'number' && Number.isFinite(required) && required > 0 ? Math.round(required) : null;
  if (req === null) return { example: null, coreTooLong: null };
  const unpaid = (Array.isArray(breaks) ? breaks : []).reduce<number>((sum, b: unknown) => {
    const br = (b ?? {}) as { paid?: boolean; minutes?: number; start?: string; end?: string };
    if (br.paid) return sum;
    if (typeof br.minutes === 'number') return sum + br.minutes;
    const s = toMin(br.start); const e = toMin(br.end);
    return s !== null && e !== null ? sum + (e >= s ? e - s : e + 1440 - s) : sum;
  }, 0);
  const cs = toMin(coreStart); const ce = toMin(coreEnd);
  const start = cs ?? 9 * 60;
  const out = (start + req + unpaid) % 1440;
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const coreSpan = cs !== null && ce !== null ? (ce > cs ? ce - cs : ce + 1440 - cs) : null;
  return {
    example: { in: clock(start), out: clock(out) },
    coreTooLong: coreSpan !== null && coreSpan > req + unpaid ? { core: hm(coreSpan), required: hm(req) } : null,
  };
}

/** The sample night used to explain the day boundary: check in on Monday evening, check out after midnight on Tuesday. */
export const SAMPLE_NIGHT = { in: '20:00', out: '03:00' } as const;
export type SampleDay = 'sun' | 'mon' | 'tue';

/**
 * The day boundary in the author's own numbers (mirrors the engine, @flowza/domain `dayBounds`): the attendance day D runs
 * `[boundary(D), boundary(D + 1))`, so a punch before the boundary belongs to the previous day. Returns the span of Monday's
 * attendance day and which day each punch of {@link SAMPLE_NIGHT} lands on; `split` = the night is torn across two days.
 */
export function dayBoundaryGuide(boundary: string | undefined | null): { boundary: string; last: string; lastDay: SampleDay; inDay: SampleDay; outDay: SampleDay; split: boolean } | null {
  const b = toMin(boundary);
  if (b === null || b >= 1440) return null;
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const days: readonly SampleDay[] = ['sun', 'mon', 'tue'];
  // minutes since Monday 00:00 → attendance day (−1 Sunday, 0 Monday, 1 Tuesday)
  const dayOf = (minute: number): SampleDay => days[Math.floor((minute - b) / 1440) + 1] ?? 'mon';
  const inDay = dayOf(toMin(SAMPLE_NIGHT.in) ?? 0);
  const outDay = dayOf(1440 + (toMin(SAMPLE_NIGHT.out) ?? 0));
  return { boundary: clock(b), last: clock((b + 1439) % 1440), lastDay: b === 0 ? 'mon' : 'tue', inDay, outDay, split: inDay !== outDay };
}

/** Required minutes ⇄ the hours + minutes the form shows; blank both ways = nothing entered yet. */
export function splitMinutes(total: unknown): { hours: string; minutes: string } {
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? { hours: String(Math.floor(total / 60)), minutes: String(Math.round(total % 60)) } : { hours: '', minutes: '' };
}
export function joinMinutes(hours: string, minutes: string): number | undefined {
  if (hours.trim() === '' && minutes.trim() === '') return undefined;
  const h = Number(hours || 0); const m = Number(minutes || 0);
  return Number.isFinite(h) && Number.isFinite(m) ? Math.round(h * 60 + m) : undefined;
}
