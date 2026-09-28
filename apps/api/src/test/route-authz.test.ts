/**
 * Route authorisation matrix (HR portal Prompt 10 — security gate). Generated from `app.routes`: every `/orgs/:orgId` route
 * of the app — present and future — is called
 *   (d) without a session                           → 401;
 *   (a) by a member of ANOTHER organisation         → 403 (the organisation access gate, before any body is read) — the
 *       platform admin without an access grant too;
 *   (b) by a member of THIS organisation holding NO permission → 403 / 404. Where the route validates its body / query
 *       first (400), the test synthesizes a request that passes the route's own schema and calls again, so the answer
 *       comes from the service's authorization — a route that checks nothing is caught even behind validation;
 *   (c) by the owner (every permission) without a body → never 5xx, and 400 whenever the route's schema requires one;
 *   (e) every /platform route: 401 without a session, 403 for an organisation owner or member who is no platform admin.
 * A route that answers a no-permission member with 2xx must be listed in MEMBERSHIP_ONLY with the reason it is
 * membership-scoped (self-service, one's own notifications, …): a new route without authorization — or without an entry —
 * fails this file. Stale entries fail it too.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { createApp } from '../app.js';
import type * as ValidateModule from '../lib/validate.js';
import { createTestApi, EMAILS, F, type TestApi } from './harness.js';
import { SAMPLE_HINTS, sampleFor, toQuery } from './schema-sample.js';

// the body / query schema the route validated last (to synthesize a request that passes it)
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

/** A member of org A whose role holds no permission at all, linked to no employee (no team, no own rows). */
const NOPERM = 'a0000000-0000-0000-0000-0000000000f9';
const NOPERM_ROLE = '0a000000-0000-0000-0000-0000000009f9';

/**
 * Routes a member with no permission may call (2xx): each is scoped to the caller's own membership or data. Everything else
 * must refuse a member without the route's permission.
 */
const MEMBERSHIP_ONLY: Record<string, string> = {
  'GET /orgs/:orgId': 'the organisation\'s own profile (name, timezone, locale): every member\'s app shell renders it',
  'GET /orgs/:orgId/settings': 'display and behaviour settings every member\'s UI and portal apply (date/time format, theme, leave and attendance rules); writes need organization.manage / notification.manage',
  'GET /orgs/:orgId/settings/:group': 'one group of the settings above',
  'GET /orgs/:orgId/roles': 'the role catalogue (names and permission keys, no member data) that labels memberships; writes need role.manage',
  'GET /orgs/:orgId/search': 'results filtered by the caller\'s own keys (employee.view, device.view, branch.view, department.view): empty without them',
  'GET /orgs/:orgId/approvals': 'the approval inbox: requests routed to the caller (assignment / delegation), not a permission',
  'GET /orgs/:orgId/approvals/inbox': 'the approval inbox (same as above)',
  'GET /orgs/:orgId/approvals/history': 'decisions the caller took or requests they filed',
  'GET /orgs/:orgId/approvals/mine': 'the requests the caller filed',
  'POST /orgs/:orgId/approvals/bulk-decide': 'decides only requests routed to the caller; every other id is answered per item as not found / not yours',
  'GET /orgs/:orgId/approval-delegations': 'the caller\'s own delegations (given and received)',
  'GET /orgs/:orgId/team/pending-counts': 'counts over the caller\'s own direct reports and the requests routed to them (zero without either)',
  'GET /orgs/:orgId/attendance/notes': 'the review queue of the caller\'s own reports and of notes routed to them; scope=all needs attendance.review_notes / attendance.approve',
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
type Route = { method: string; path: string };

function fill(path: string, orgId: string): string {
  return path.replace('/api/v1', '').replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    if (name === 'orgId') return orgId;
    if (name === 'group') return 'general';
    if (name === 'action') return 'health-check';
    return randomUUID();
  });
}

let api: TestApi;
let routes: Route[];

beforeAll(async () => {
  api = await createTestApi('routeauthz');
  const a = api.tdb.adminDb;
  EMAILS[NOPERM] = 'noperm-a@test.local';
  await sql`insert into auth.users (id, email) values (${NOPERM}::uuid, 'noperm-a@test.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: NOPERM, email: 'noperm-a@test.local', fullName: 'No Permission' }).execute();
  await a.insertInto('roles').values({ id: NOPERM_ROLE, organizationId: F.orgA, key: 'no_access', name: 'No access' }).execute();
  await a.insertInto('orgMemberships').values({ organizationId: F.orgA, userId: NOPERM, roleId: NOPERM_ROLE, status: 'active', allBranches: true, joinedAt: new Date() }).execute();
  const app = createApp(api.deps);
  const seen = new Set<string>();
  routes = app.routes
    .filter((r) => r.method !== 'ALL' && (r.path === '/api/v1/orgs/:orgId' || r.path.startsWith('/api/v1/orgs/:orgId/')))
    .filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((r) => ({ method: r.method, path: r.path }));
}, 180_000);

afterAll(async () => { await api?.close(); });

const key = (r: Route) => `${r.method} ${r.path.replace('/api/v1', '')}`;

describe('route authorisation matrix (every /orgs/:orgId route)', () => {
  it('enumerates the organisation routes of the app', () => {
    expect(routes.length).toBeGreaterThan(250);
  });

  it('(d) refuses every organisation route without a session (401)', async () => {
    const bad: string[] = [];
    for (const r of routes) {
      const res = await api.request(r.method, fill(r.path, F.orgA), MUTATING.has(r.method) ? { body: {} } : {});
      if (res.status !== 401) bad.push(`${key(r)} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('(a) refuses a member of another organisation — and a platform admin without a grant — before reading anything (403)', async () => {
    const bad: string[] = [];
    for (const r of routes) {
      for (const user of [F.ownerB, F.platformAdmin]) {
        const res = await api.request(r.method, fill(r.path, F.orgA), { user, ...(MUTATING.has(r.method) ? { body: {} } : {}) });
        if (res.status !== 403) bad.push(`${key(r)} as ${user === F.ownerB ? 'owner B' : 'platform admin'} → ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('(b) refuses a member of this organisation holding no permission (403 / 404), behind validation too', async () => {
    const bad: string[] = [];
    const unsynthesizable: string[] = [];
    const reachedService: string[] = [];
    for (const r of routes) {
      captured.body = undefined; captured.query = undefined;
      const path = fill(r.path, F.orgA);
      let res = await api.request(r.method, path, { user: NOPERM, ...(MUTATING.has(r.method) ? { body: {} } : {}) });
      if (res.status === 400 && (captured.body || captured.query)) {
        const bodySchema = captured.body as z.ZodType | undefined;
        const querySchema = captured.query as z.ZodType | undefined;
        // required fields only first; then with the optional ones too (a rule the schema cannot express — a reject needs
        // its comment, a range needs both ends — is often met by the fuller request)
        const hint = SAMPLE_HINTS[key(r)];
        const withHint = (b: unknown) => (hint && b && typeof b === 'object' ? JSON.parse(JSON.stringify({ ...(b as object), ...hint })) : b);
        const candidates = [false, true].map((optional) => ({
          body: bodySchema ? withHint(sampleFor(bodySchema, { optional })) : undefined,
          query: querySchema ? sampleFor(querySchema, { optional }) : undefined,
        })).filter((c) => (!bodySchema || bodySchema.safeParse(c.body).success) && (!querySchema || querySchema.safeParse(c.query).success));
        if (candidates.length === 0) {
          const issues = [bodySchema?.safeParse(sampleFor(bodySchema, { optional: true })).error, querySchema?.safeParse(sampleFor(querySchema, { optional: true })).error]
            .flatMap((e) => e?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);
          unsynthesizable.push(`${key(r)} — ${issues.join('; ')}`);
          continue;
        }
        for (const cand of candidates) {
          res = await api.request(r.method, path + (querySchema ? toQuery(cand.query) : ''), { user: NOPERM, ...(cand.body !== undefined ? { body: cand.body } : MUTATING.has(r.method) ? { body: {} } : {}) });
          if (res.status !== 400) break;
        }
        reachedService.push(key(r));
      }
      const allowed = MEMBERSHIP_ONLY[key(r)] !== undefined;
      if (allowed ? res.status >= 500 : ![403, 404].includes(res.status)) bad.push(`${key(r)} → ${res.status} ${res.json?.code ?? ''} ${res.json?.message ?? ''}`.trim());
    }
    expect(bad).toEqual([]);
    expect(unsynthesizable).toEqual([]);
    expect(reachedService.length).toBeGreaterThan(0);
  });

  it('(c) answers the owner\'s mutating calls without a body with 400 where a body is required, and never 5xx', async () => {
    const bad: string[] = [];
    for (const r of routes.filter((x) => MUTATING.has(x.method))) {
      captured.body = undefined;
      const res = await api.request(r.method, fill(r.path, F.orgA), { user: F.ownerA });
      const schema = captured.body as z.ZodType | undefined;
      // a limiter answering first would make this check vacuous (it did, while the inbound limiter covered the whole app)
      if (res.status >= 500 || res.status === 429) bad.push(`${key(r)} → ${res.status}`);
      else if (schema && !schema.safeParse({}).success && res.status !== 400) bad.push(`${key(r)} → ${res.status} (a body is required)`);
    }
    expect(bad).toEqual([]);
  });

  it('(e) refuses every platform route to a non-platform administrator (403) and without a session (401)', async () => {
    const platformRoutes = createApp(api.deps).routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/v1/platform/'))
      .filter((r, i, all) => all.findIndex((x) => x.method === r.method && x.path === r.path) === i);
    expect(platformRoutes.length).toBeGreaterThan(8);
    const bad: string[] = [];
    for (const r of platformRoutes) {
      const path = fill(r.path, F.orgA);
      const anonymous = await api.request(r.method, path, MUTATING.has(r.method) ? { body: {} } : {});
      if (anonymous.status !== 401) bad.push(`${r.method} ${r.path} anonymous → ${anonymous.status}`);
      for (const user of [F.ownerA, NOPERM]) {
        const res = await api.request(r.method, path, { user, ...(MUTATING.has(r.method) ? { body: {} } : {}) });
        if (res.status !== 403) bad.push(`${r.method} ${r.path} as ${user === F.ownerA ? 'an organisation owner' : 'a member'} → ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps its allow-lists honest: every MEMBERSHIP_ONLY / SAMPLE_HINTS entry names a live route', () => {
    const live = new Set(routes.map(key));
    expect([...Object.keys(MEMBERSHIP_ONLY), ...Object.keys(SAMPLE_HINTS)].filter((k) => !live.has(k))).toEqual([]);
  });
});
