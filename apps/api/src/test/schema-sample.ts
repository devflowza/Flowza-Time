import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * A request that PASSES a route's own Zod schema, generated from the schema (JSON-Schema view, input side): required
 * properties only, the first enum value, a format-shaped string, the minimum of a number. Refinements are invisible to the
 * JSON-Schema view, so a generated value can still fail them — callers check `schema.safeParse` and treat a miss as
 * "not synthesizable" instead of guessing. Used by the route authorisation matrix to reach a service's authorization check
 * behind body / query validation (a no-permission caller must be refused by the service, not merely by a malformed body).
 */
type Json = Record<string, unknown>;

const STRING_CANDIDATES = ['08:00', '2026-09-01', 'PROBE', 'probe', 'probe_x', 'P-1', '1', 'probe.value', '2026-09', 'ABC', 'a1', '+96890000000', '#1d4ed8'];

/** Instants / times come out in increasing order within one sample, so "check-out after check-in" style rules hold. */
let clock = 0;

export function sampleFor(schema: z.ZodType, opts: { optional?: boolean } = {}): unknown {
  let js: Json;
  try {
    js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  } catch {
    return {};
  }
  clock = 0;
  return gen(js, js, 0, opts.optional ?? false);
}

/**
 * Body fragments for rules a JSON-Schema view of a route's schema cannot show (cross-field refinements), keyed by route
 * (`METHOD /path` without the /api/v1 prefix). Merged over the generated sample; the result must still pass the route's own
 * schema. A new route whose body cannot be synthesized fails the route matrix until it gets a fragment here.
 */
export const SAMPLE_HINTS: Record<string, Record<string, unknown>> = {
  'POST /orgs/:orgId/devices/:id/credentials': { apiKey: 'probe-secret' },
  'POST /orgs/:orgId/shift-assignments': { shiftId: '0a000000-0000-0000-0000-00000000c0de', shiftPatternId: undefined },
  'POST /orgs/:orgId/report-schedules': { reportType: 'late_report', cadence: 'monthly', runDay: 5, periodRule: 'previous_month' },
};

/**
 * A sample for `schema` that passes it, with the route's hint merged: the minimal one (required fields) first by default, or
 * the full one (optional fields too) first with `prefer: 'full'`.
 */
export function validSample(schema: z.ZodType, hint?: Record<string, unknown>, prefer: 'minimal' | 'full' = 'minimal'): { ok: true; value: unknown } | { ok: false; issues: string[] } {
  const merge = (b: unknown) => (hint && b && typeof b === 'object' && !Array.isArray(b) ? JSON.parse(JSON.stringify({ ...(b as object), ...hint })) : b);
  let last: z.ZodError | undefined;
  for (const optional of prefer === 'full' ? [true, false] : [false, true]) {
    const v = merge(sampleFor(schema, { optional }));
    const r = schema.safeParse(v);
    if (r.success) return { ok: true, value: v };
    last = r.error;
  }
  return { ok: false, issues: (last?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`) };
}

/** Query-string pairs for a sample object (arrays repeat the key). */
export function toQuery(sample: unknown): string {
  if (!sample || typeof sample !== 'object') return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sample as Json)) {
    if (v === undefined || v === null) continue;
    for (const item of Array.isArray(v) ? v : [v]) qs.append(k, typeof item === 'object' ? JSON.stringify(item) : String(item));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

function resolve(s: Json, root: Json): Json {
  const ref = s['$ref'];
  if (typeof ref !== 'string') return s;
  const key = ref.replace(/^#\/(\$defs|definitions)\//, '');
  const defs = (root['$defs'] ?? root['definitions'] ?? {}) as Record<string, Json>;
  return ref === '#' ? root : defs[key] ?? {};
}

function gen(s0: Json, root: Json, depth: number, optional: boolean): unknown {
  if (typeof s0 !== 'object' || s0 === null) return s0 === false ? undefined : {}; // boolean schemas (`true` = anything)
  const s = resolve(s0, root);
  if (depth > 8) return null;
  if ('const' in s) return s['const'];
  if (Array.isArray(s['enum']) && s['enum'].length > 0) return s['enum'][0];
  const alternatives = (s['anyOf'] ?? s['oneOf']) as Json[] | undefined;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    const pick = alternatives.find((o) => resolve(o, root)['type'] !== 'null') ?? alternatives[0]!;
    return gen(pick, root, depth + 1, optional);
  }
  if (Array.isArray(s['allOf'])) return Object.assign({}, ...(s['allOf'] as Json[]).map((x) => gen(x, root, depth + 1, optional) as Json));
  const t = s['type'];
  const type = Array.isArray(t) ? (t as string[]).find((x) => x !== 'null') : (t as string | undefined);
  switch (type) {
    case 'object': {
      const out: Json = {};
      const required = new Set((s['required'] as string[] | undefined) ?? []);
      for (const [k, v] of Object.entries((s['properties'] ?? {}) as Record<string, Json>)) if (optional || required.has(k)) out[k] = gen(v, root, depth + 1, optional);
      return out;
    }
    case 'array': {
      const n = Math.max(Number(s['minItems'] ?? 1), 1);
      return Array.from({ length: n }, () => gen((s['items'] ?? {}) as Json, root, depth + 1, optional));
    }
    case 'string': return sampleString(s);
    case 'integer':
    case 'number': {
      let v = typeof s['minimum'] === 'number' ? s['minimum'] : typeof s['exclusiveMinimum'] === 'number' ? (s['exclusiveMinimum'] as number) + 1 : 1;
      if (typeof s['maximum'] === 'number' && v > s['maximum']) v = s['maximum'];
      return v;
    }
    case 'boolean': return false;
    case 'null': return null;
    default: return {};
  }
}

function sampleString(s: Json): string {
  switch (s['format']) {
    case 'uuid': case 'guid': return randomUUID();
    case 'email': return 'probe@test.local';
    case 'date': return '2026-09-01';
    case 'date-time': return new Date(Date.UTC(2026, 8, 1, 6 + clock++)).toISOString();
    case 'time': return `${String(8 + clock++).padStart(2, '0')}:00:00`;
    case 'uri': case 'url': return 'https://example.test/probe';
    case 'ipv4': return '127.0.0.1';
    default: break;
  }
  const min = Number(s['minLength'] ?? 1);
  const max = Number(s['maxLength'] ?? 200);
  const fits = (v: string) => v.length >= min && v.length <= max;
  if (typeof s['pattern'] === 'string') {
    let re: RegExp | null = null;
    try { re = new RegExp(s['pattern'] as string); } catch { re = null; }
    const hit = re ? STRING_CANDIDATES.find((c) => re!.test(c) && fits(c)) : undefined;
    if (hit) return hit;
  }
  const len = Math.min(Math.max(5, min), max);
  return ('probe' + 'x'.repeat(Math.max(0, len))).slice(0, len);
}
