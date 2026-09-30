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
