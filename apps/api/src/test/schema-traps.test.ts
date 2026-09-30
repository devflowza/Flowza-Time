/**
 * Request-schema traps (HR portal Prompt 10 — security gate). Every body / query schema the API validates is collected from
 * the running app — one call per route, so a route added tomorrow is covered without a list — and must:
 *   1. PATCH / PUT: parse `{}` to `{}` (or refuse it): a partial update never injects a default for a field the client did
 *      not send, and a one-field update carries that one field only;
 *   2. handle unknown keys one way: dropped (Zod's default), or refused where the schema is strict BY DESIGN (listed below
 *      with the reason) — never passed through to the service; only the listed maps take keys the client names;
 *   3. be bounded: every array declares maxItems, every free-text string maxLength, every map bounds its keys and values;
 *   4. never let a self-service request name the tenant or the actor (organizationId, employeeId, userId, requestedBy, …):
 *      the caller's membership decides; and no organisation route takes an organisation id anywhere but its path.
 * The settings-group PUT validates inside its service (organizationSettingsSchema.shape[group]); its schemas are checked
 * directly at the end.
 */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { organizationSettingsSchema } from '@flowza/contracts';
import { createApp } from '../app.js';
import type * as ValidateModule from '../lib/validate.js';
import { createTestApi, F, type TestApi } from './harness.js';
import { SAMPLE_HINTS, sampleFor, toQuery, validSample } from './schema-sample.js';

const captured = vi.hoisted(() => ({ body: undefined as unknown, query: undefined as unknown }));
vi.mock('../lib/validate.js', async (importOriginal) => {
  const orig = await importOriginal<typeof ValidateModule>();
  return {
    ...orig,
    body: (c: Parameters<typeof orig.body>[0], schema: Parameters<typeof orig.body>[1]) => { captured.body = schema; return orig.body(c, schema); },
    optionalBody: (c: Parameters<typeof orig.optionalBody>[0], schema: Parameters<typeof orig.optionalBody>[1]) => { captured.body = schema; return orig.optionalBody(c, schema); },
    query: (c: Parameters<typeof orig.query>[0], schema: Parameters<typeof orig.query>[1]) => { captured.query = schema; return orig.query(c, schema); },
  };
});

/** Objects that are maps BY DESIGN (the client names the keys; keys are validated names, values bounded). Path `<root>` = the body. */
const MAPS: Record<string, string> = {
  'POST /orgs/:orgId/devices/:id/credentials body.<root>': 'provider credential fields (apiKey, secret, …): validated names, bounded values, encrypted at rest, never echoed',
  'POST /orgs/:orgId/devices body.config': 'provider configuration fields named by the provider (secrets split out server-side); at most 64 fields',
  'POST /orgs/:orgId/devices/test-connection body.config': 'the same provider configuration, tested without being stored',
  'PUT /platform/orgs/:id/feature-flags body.flags': 'feature-flag key → on/off (platform admins; keys are the platform catalogue)',
  'POST /orgs/:orgId/employees body.customFields': 'the employee\'s custom fields: named scalar values, at most 50',
  'PATCH /orgs/:orgId/employees/:id body.customFields': 'the same custom fields',
};

/** Objects strict BY DESIGN: an unknown key is refused (400) instead of dropped. */
const STRICT: Record<string, string> = {
  'PUT /me/notification-preferences body.<root>': 'the whole preference matrix is replaced: a misspelt field must not silently reset a preference',
  'PUT /me/notification-preferences body.preferences[]': 'each (category, channel) row is stored as sent',
  'POST /orgs/:orgId/report-schedules body.filters': 'stored and replayed by every scheduled run: a key the server did not validate must never reach the report generator',
  'PATCH /orgs/:orgId/report-schedules/:id body.filters': 'the same stored filters',
  'PUT /platform/orgs/:id/modules body.modules': 'module key → on / off / back to the plan: the keys are the module catalogue, a misspelt module must not be silently ignored',
  'POST /platform/plans body.limits': 'plan limits are enforced by key (employees, devices, …): an unknown limit is refused, never stored as if it meant something',
  'PATCH /platform/plans/:key body.limits': 'the same plan limits',
};

/** Self-service requests that legitimately carry an organisation id: /me is not organisation-scoped (membership is checked). */
const IDENTITY_ALLOWED: Record<string, string> = {
  'GET /me/notifications query.organizationId': 'filters the caller\'s own notifications; a non-member organisation yields nothing',
  'GET /me/notification-preferences query.organizationId': 'which organisation\'s preferences (membership required, own rows only)',
  'PUT /me/notification-preferences query.organizationId': 'which organisation\'s preferences (membership required, own rows only)',
};
const IDENTITY_FIELDS = new Set(['organizationId', 'orgId', 'tenantId', 'employeeId', 'userId', 'actorUserId', 'requestedBy', 'createdBy', 'updatedBy', 'decidedBy', 'submittedBy', 'approvedBy', 'membershipId', 'ownerUserId']);
const TENANT_FIELDS = new Set(['organizationId', 'orgId', 'tenantId']);
/** String formats whose values are bounded by the format itself. */
const BOUNDED_FORMATS = new Set(['uuid', 'guid', 'date', 'date-time', 'time', 'ipv4', 'ipv6', 'duration']);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
type Collected = { key: string; method: string; path: string; body?: z.ZodType; query?: z.ZodType };
let api: TestApi;
const collected: Collected[] = [];

function fill(path: string): string {
  return path.replace('/api/v1', '').replace(/:([A-Za-z]+)/g, (_m, name: string) => (name === 'orgId' ? F.orgA : name === 'group' ? 'general' : name === 'action' ? 'health-check' : randomUUID()));
}

beforeAll(async () => {
  api = await createTestApi('schematraps');
  const app = createApp(api.deps);
  const seen = new Set<string>();
  for (const r of app.routes) {
    if (r.method === 'ALL' || !r.path.startsWith('/api/v1/')) continue;
    const key = `${r.method} ${r.path.replace('/api/v1', '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const user = r.path.startsWith('/api/v1/platform') ? F.platformAdmin : F.ownerA;
    const path = fill(r.path);
    captured.body = undefined; captured.query = undefined;
    await api.request(r.method, path, { user, ...(MUTATING.has(r.method) ? { body: {} } : {}) });
    let body = captured.body as z.ZodType | undefined;
    const query = captured.query as z.ZodType | undefined;
    // the query was validated (and refused) before the body: call again with a valid query to reach the body's schema
    if (!body && MUTATING.has(r.method) && query) {
      const q = validSample(query);
      if (q.ok) { captured.body = undefined; await api.request(r.method, path + toQuery(q.value), { user, body: {} }); body = captured.body as z.ZodType | undefined; }
    }
    collected.push({ key, method: r.method, path: r.path, ...(body ? { body } : {}), ...(query ? { query } : {}) });
  }
}, 240_000);

afterAll(async () => { await api?.close(); });

type Json = Record<string, unknown>;
function jsonSchema(schema: z.ZodType): Json | null {
  try { return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json; } catch { return null; }
}
/** Walks a JSON Schema, following $refs once, calling `visit(node, path)` on every node. */
function walkSchema(root: Json, visit: (node: Json, path: string) => void): void {
  const seenRefs = new Set<string>();
  const walk = (s: unknown, path: string, depth: number) => {
    if (!s || typeof s !== 'object' || depth > 12) return;
    const node = s as Json;
    if (typeof node['$ref'] === 'string') {
      const ref = node['$ref'] as string;
      if (seenRefs.has(ref)) return;
      seenRefs.add(ref);
      const defs = (root['$defs'] ?? root['definitions'] ?? {}) as Record<string, Json>;
      walk(ref === '#' ? root : defs[ref.replace(/^#\/(\$defs|definitions)\//, '')], path, depth + 1);
      return;
    }
    visit(node, path);
    for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(node[k])) for (const x of node[k] as unknown[]) walk(x, path, depth + 1);
    if (node['properties']) for (const [k, v] of Object.entries(node['properties'] as Record<string, unknown>)) walk(v, path === '<root>' ? k : `${path}.${k}`, depth + 1);
    if (node['items']) walk(node['items'], `${path}[]`, depth + 1);
    if (node['additionalProperties'] && typeof node['additionalProperties'] === 'object') walk(node['additionalProperties'], `${path}{}`, depth + 1);
    if (node['propertyNames'] && typeof node['propertyNames'] === 'object') walk(node['propertyNames'], `${path}{key}`, depth + 1);
  };
  walk(root, '<root>', 0);
}
const typesOf = (node: Json): string[] => (Array.isArray(node['type']) ? (node['type'] as string[]) : typeof node['type'] === 'string' ? [node['type'] as string] : []);
/** A regex with no unbounded quantifier (`*`, `+`, `{n,}`) bounds the string's length by itself. */
const boundedPattern = (p: string) => !/(^|[^\\])[*+]|\{\d+,\}/.test(p);

describe('request schema traps (every route of the app)', () => {
  it('collects the body / query schema of every route that validates one', () => {
    expect(collected.length).toBeGreaterThan(280);
    expect(collected.filter((c) => c.body).length).toBeGreaterThan(120);
    expect(collected.filter((c) => c.query).length).toBeGreaterThan(80);
  });

  it('PATCH / PUT: {} parses to {} (or is refused), and a one-field PATCH carries that field only — no injected default', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const c of collected.filter((x) => (x.method === 'PATCH' || x.method === 'PUT') && x.body)) {
      checked += 1;
      const empty = c.body!.safeParse({});
      if (empty.success && !isDeepStrictEqual(empty.data, {})) bad.push(`${c.key}: {} → ${JSON.stringify(empty.data)}`);
      // PUT replaces the resource (a full body, defaults for what it leaves out); PATCH changes what it names and nothing else
      if (c.method !== 'PATCH') continue;
      const full = sampleFor(c.body!, { optional: true });
      if (!full || typeof full !== 'object' || Array.isArray(full)) continue;
      for (const [field, value] of Object.entries(full as Json)) {
        const one = c.body!.safeParse({ [field]: value });
        if (!one.success || !one.data || typeof one.data !== 'object') continue;
        const extra = Object.keys(one.data as Json).filter((k) => k !== field && (one.data as Json)[k] !== undefined);
        if (extra.length) bad.push(`${c.key}: {${field}} → also ${extra.join(', ')}`);
      }
    }
    expect(checked).toBeGreaterThan(25);
    expect(bad).toEqual([]);
  });

  it('unknown keys are dropped — or refused where the schema is strict by design — never passed through (maps excepted)', () => {
    const passthrough: string[] = [];
    const strict: string[] = [];
    const unsynthesizable: string[] = [];
    for (const c of collected) {
      for (const [where, schema] of [['body', c.body], ['query', c.query]] as const) {
        if (!schema) continue;
        const sample = validSample(schema, where === 'body' ? SAMPLE_HINTS[c.key] : undefined, 'full');
        if (!sample.ok) { unsynthesizable.push(`${c.key} ${where} — ${sample.issues.join('; ')}`); continue; }
        // every object of the valid sample, the root included
        const paths: Array<Array<string | number>> = [];
        const collect = (v: unknown, p: Array<string | number>) => {
          if (!v || typeof v !== 'object') return;
          if (!Array.isArray(v)) paths.push(p);
          for (const [k, x] of Object.entries(v as Json)) collect(x, [...p, Array.isArray(v) ? Number(k) : k]);
        };
        collect(sample.value, []);
        for (const p of paths) {
          const label = `${c.key} ${where}.${p.length ? p.map((s) => (typeof s === 'number' ? '[]' : s)).join('.').replace(/\.\[\]/g, '[]') : '<root>'}`;
          const copy = JSON.parse(JSON.stringify(sample.value)) as Json;
          let target: Json = copy;
          for (const seg of p) target = target[seg as string] as Json;
          target['zzUnknownKey'] = 'probe';
          const r = schema.safeParse(copy);
          if (r.success) {
            if (JSON.stringify(r.data).includes('zzUnknownKey') && MAPS[label] === undefined) passthrough.push(label);
          } else if (r.error.issues.some((i) => i.code === 'unrecognized_keys')) {
            strict.push(label);
          }
        }
      }
    }
    expect(unsynthesizable).toEqual([]);
    expect(passthrough).toEqual([]);
    // strictness is a documented decision: every strict object is listed with its reason, and every listed one is strict
    expect(strict.filter((s) => STRICT[s] === undefined)).toEqual([]);
    expect(Object.keys(STRICT).filter((s) => !strict.includes(s))).toEqual([]);
  });

  it('every array declares maxItems, every free-text string maxLength, every map bounds its keys and values', () => {
    const unbounded: string[] = [];
    for (const c of collected) {
      for (const [where, schema] of [['body', c.body], ['query', c.query]] as const) {
        if (!schema) continue;
        const js = jsonSchema(schema);
        if (!js) { unbounded.push(`${c.key} ${where}: not representable`); continue; }
        walkSchema(js, (node, path) => {
          const types = typesOf(node);
          if (types.includes('array') && typeof node['maxItems'] !== 'number') unbounded.push(`${c.key} ${where}.${path}: array without maxItems`);
          if (types.includes('string') && typeof node['maxLength'] !== 'number' && node['enum'] === undefined && node['const'] === undefined
            && !(typeof node['format'] === 'string' && BOUNDED_FORMATS.has(node['format'] as string))
            && !(typeof node['pattern'] === 'string' && boundedPattern(node['pattern'] as string))) {
            unbounded.push(`${c.key} ${where}.${path}: string without maxLength`);
          }
          if (types.includes('object') && node['additionalProperties'] && typeof node['additionalProperties'] === 'object' && !node['propertyNames']) {
            unbounded.push(`${c.key} ${where}.${path}: map without bounded keys`);
          }
        });
      }
    }
    expect(unbounded).toEqual([]);
  });

  it('a self-service request never names the tenant or the actor; no organisation route takes an organisation id outside its path', () => {
    const bad: string[] = [];
    for (const c of collected) {
      const self = c.path.startsWith('/api/v1/me') || c.path.startsWith('/api/v1/orgs/:orgId/me/') || c.path === '/api/v1/orgs/:orgId/me';
      const orgScoped = c.path.startsWith('/api/v1/orgs/:orgId');
      for (const [where, schema] of [['body', c.body], ['query', c.query]] as const) {
        if (!schema) continue;
        const js = jsonSchema(schema);
        if (!js) continue;
        walkSchema(js, (node, path) => {
          if (!node['properties']) return;
          for (const prop of Object.keys(node['properties'] as Json)) {
            const label = `${c.key} ${where}.${path === '<root>' ? prop : `${path}.${prop}`}`;
            if (self && IDENTITY_FIELDS.has(prop) && IDENTITY_ALLOWED[label] === undefined) bad.push(`${label} (self-service)`);
            if (orgScoped && TENANT_FIELDS.has(prop)) bad.push(`${label} (organisation route)`);
          }
        });
      }
    }
    expect(bad).toEqual([]);
  });

  it('the settings-group PUT (validated in its service): every group drops unknown keys and bounds its fields', () => {
    const bad: string[] = [];
    for (const [group, schema] of Object.entries(organizationSettingsSchema.shape) as Array<[string, z.ZodType]>) {
      const parsed = schema.parse({}); // PUT replaces the whole group: {} is the group's defaults (the web sends the group it read)
      const withUnknown = schema.safeParse({ ...(parsed as Json), zzUnknownKey: 'probe' });
      if (!withUnknown.success || JSON.stringify(withUnknown.data).includes('zzUnknownKey')) bad.push(`${group}: unknown key not dropped`);
      const js = jsonSchema(schema);
      if (!js) { bad.push(`${group}: not representable`); continue; }
      walkSchema(js, (node, path) => {
        const types = typesOf(node);
        if (types.includes('array') && typeof node['maxItems'] !== 'number') bad.push(`${group}.${path}: array without maxItems`);
        if (types.includes('string') && typeof node['maxLength'] !== 'number' && node['enum'] === undefined && node['const'] === undefined
          && !(typeof node['format'] === 'string' && BOUNDED_FORMATS.has(node['format'] as string))
          && !(typeof node['pattern'] === 'string' && boundedPattern(node['pattern'] as string))) bad.push(`${group}.${path}: string without maxLength`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('keeps its allow-lists honest: every entry names a live route', () => {
    const live = new Set(collected.map((c) => c.key));
    const routeOf = (entry: string) => entry.split(' ').slice(0, 2).join(' ');
    expect([...Object.keys(MAPS), ...Object.keys(STRICT), ...Object.keys(IDENTITY_ALLOWED)].map(routeOf).filter((k) => !live.has(k))).toEqual([]);
  });
});
