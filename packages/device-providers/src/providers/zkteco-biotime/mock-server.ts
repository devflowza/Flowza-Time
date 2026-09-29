import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process stand-in for a ZKBio Time / BioTime 8.0 server (tests only), faithful to the API manual: `POST /jwt-api-token-auth/`
 * and `POST /api-token-auth/` (400 on bad credentials, like DRF), `Authorization: JWT|Token <token>` (401 otherwise), list
 * envelopes `{ count, next, previous, msg, code, data }` paged with `page` + `limit` (404 "Invalid page." past the end, like
 * DRF), `start_time`/`end_time`/`terminal_sn`/`emp_code` filters, employee create (needs department + area) / patch / delete.
 * Row ordering is configurable because the manual does not document it — the provider must not depend on it.
 */

export interface MockBioTimeTransaction {
  id: number;
  emp_code: string;
  punch_time: string;
  punch_state: string;
  verify_type: number;
  work_code?: string | null;
  terminal_sn: string;
  terminal_alias?: string | null;
  area_alias?: string | null;
  upload_time?: string | null;
  source?: number | null;
  purpose?: number | null;
  is_attendance?: number | null;
  longitude?: number | null;
  latitude?: number | null;
  gps_location?: string | null;
  temperature?: number | null;
  is_mask?: number | null;
}
export interface MockBioTimeTerminal {
  id: number; sn: string; alias: string; ip_address: string; state: number; terminal_tz: number; last_activity: string | null;
  fw_ver: string | null; push_ver: string; user_count: number | null; fp_count: number | null; face_count: number | null; palm_count: number | null; transaction_count: number | null;
  area: { id: number; area_code: string; area_name: string };
}
export interface MockBioTimeEmployee {
  id: number; emp_code: string; first_name: string; last_name: string; card_no: string; device_password: string;
  department: number; area: number[]; dev_privilege: number;
}

export interface MockBioTimeOptions {
  username?: string;
  password?: string;
  /** false → `/jwt-api-token-auth/` answers 404 (older/stripped builds), so clients must use `/api-token-auth/`. */
  jwt?: boolean;
  /** JWT lifetime in seconds (encoded in the `exp` claim). */
  jwtTtlSeconds?: number;
  transactions?: MockBioTimeTransaction[];
  terminals?: MockBioTimeTerminal[];
  employees?: MockBioTimeEmployee[];
  /** Server-side ordering of transactions (undocumented in the manual). */
  order?: 'id' | '-punch_time';
  /** When set, the server ignores `limit` and always uses this page size. */
  forcedPageSize?: number;
  /** Clock used for the JWT `exp` claim and expiry checks (default: real time). */
  now?: () => number;
}

export interface MockBioTimeRequest { method: string; path: string; query: Record<string, string>; authorization: string | undefined; body: unknown }
export interface MockBioTimeFault { status: number; body?: unknown; headers?: Record<string, string>; times?: number; path?: string }

export interface MockBioTimeServer {
  baseUrl: string;
  transactions: MockBioTimeTransaction[];
  terminals: MockBioTimeTerminal[];
  employees: MockBioTimeEmployee[];
  requests: MockBioTimeRequest[];
  /** Tokens currently accepted. */
  tokens: Set<string>;
  /** Invalidate every issued token (simulates expiry / server restart): the next API call answers 401. */
  expireTokens(): void;
  failNext(fault: MockBioTimeFault): void;
  /** Runs once, right after the next request to `path` has been answered (to mutate data between two pages). */
  afterNext(path: string, fn: () => void): void;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) { res.writeHead(204, headers); res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

export async function createMockBioTimeServer(options: MockBioTimeOptions = {}): Promise<MockBioTimeServer> {
  const username = options.username ?? 'api-user';
  const password = options.password ?? 'api-secret-pass';
  const jwtEnabled = options.jwt ?? true;
  const now = options.now ?? (() => Date.now());
  const transactions = [...(options.transactions ?? [])];
  const terminals = [...(options.terminals ?? [])];
  const employees = [...(options.employees ?? [])];
  const requests: MockBioTimeRequest[] = [];
  const tokens = new Set<string>();
  const jwtExpiry = new Map<string, number>();
  const faults: MockBioTimeFault[] = [];
  const after: Array<{ path: string; fn: () => void }> = [];
  let port = 0;

  const page = <T>(res: ServerResponse, url: URL, rows: T[]): void => {
    const size = options.forcedPageSize ?? Math.max(1, Math.min(10_000, Number(url.searchParams.get('limit') ?? '10') || 10));
    const n = Number(url.searchParams.get('page') ?? '1');
    const pages = Math.max(1, Math.ceil(rows.length / size));
    if (!Number.isInteger(n) || n < 1 || n > pages) return send(res, 404, { detail: 'Invalid page.' });
    const link = (p: number): string => { const u = new URL(`http://127.0.0.1:${port}${url.pathname}${url.search}`); u.searchParams.set('page', String(p)); return u.toString(); };
    send(res, 200, { count: rows.length, next: n < pages ? link(n + 1) : null, previous: n > 1 ? link(n - 1) : null, msg: '', code: 0, data: rows.slice((n - 1) * size, n * size) });
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const body = method === 'GET' || method === 'DELETE' ? undefined : await readJson(req);
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    requests.push({ method, path, query: Object.fromEntries(url.searchParams), authorization, body });
    try {
      const faultIdx = faults.findIndex((f) => !f.path || f.path === path);
      if (faultIdx >= 0) {
        const fault = faults[faultIdx]!;
        if ((fault.times ?? 1) <= 1) faults.splice(faultIdx, 1); else fault.times = (fault.times ?? 1) - 1;
        return send(res, fault.status, fault.body ?? { detail: `injected ${fault.status}` }, fault.headers ?? {});
      }

      if (method === 'POST' && (path === '/jwt-api-token-auth/' || path === '/api-token-auth/')) {
        if (path === '/jwt-api-token-auth/' && !jwtEnabled) return send(res, 404, '<h1>Not Found</h1>', { 'content-type': 'text/html' });
        const b = body as { username?: unknown; password?: unknown } | null;
        if (!b || b.username !== username || b.password !== password) return send(res, 400, { non_field_errors: ['Unable to log in with provided credentials.'] });
        if (path === '/jwt-api-token-auth/') {
          const exp = Math.floor(now() / 1000) + (options.jwtTtlSeconds ?? 300);
          const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ username, exp })}.${randomBytes(16).toString('base64url')}`;
          tokens.add(token); jwtExpiry.set(token, exp * 1000);
          return send(res, 200, { token });
        }
        const token = randomBytes(20).toString('hex');
        tokens.add(token);
        return send(res, 200, { token });
      }

      const m = /^(JWT|Token) (.+)$/.exec(authorization ?? '');
      const token = m?.[2];
      const expired = token !== undefined && (jwtExpiry.get(token) ?? Infinity) <= now();
      if (!m || !token || !tokens.has(token) || expired || (m[1] === 'JWT') !== jwtExpiry.has(token)) {
        return send(res, 401, { detail: expired ? 'Signature has expired.' : 'Authentication credentials were not provided.' }, { 'www-authenticate': 'JWT realm="api"' });
      }

      if (method === 'GET' && path === '/iclock/api/terminals/') {
        const sn = url.searchParams.get('sn');
        return page(res, url, terminals.filter((t) => !sn || t.sn === sn));
      }
      if (method === 'GET' && path === '/iclock/api/transactions/') {
        const q = (k: string): string | null => url.searchParams.get(k);
        const start = q('start_time'); const end = q('end_time'); const sn = q('terminal_sn'); const emp = q('emp_code');
        // punch_time strings are `YYYY-MM-DD HH:mm:ss` wall time, so lexical comparison is chronological.
        const rows = transactions.filter((t) => (!start || t.punch_time >= start) && (!end || t.punch_time <= end) && (!sn || t.terminal_sn === sn) && (!emp || t.emp_code === emp));
        rows.sort(options.order === '-punch_time' ? (a, b) => (a.punch_time < b.punch_time ? 1 : a.punch_time > b.punch_time ? -1 : b.id - a.id) : (a, b) => a.id - b.id);
        return page(res, url, rows);
      }
      if (path === '/personnel/api/employees/') {
        if (method === 'GET') {
          const emp = url.searchParams.get('emp_code');
          // `emp_code` behaves as a contains-filter here, so the client must re-check exact matches.
          const rows = employees.filter((e) => !emp || e.emp_code.includes(emp)).sort((a, b) => a.id - b.id)
            .map((e) => ({ id: e.id, emp_code: e.emp_code, first_name: e.first_name, last_name: e.last_name, card_no: e.card_no, device_password: e.device_password, self_password: 'pbkdf2_sha256$36000$x$y', department: { id: e.department, dept_code: String(e.department), dept_name: 'Department' }, area: e.area.map((id) => ({ id, area_code: String(id), area_name: 'Area' })), dev_privilege: e.dev_privilege }));
          return page(res, url, rows);
        }
        if (method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          const code = typeof b['emp_code'] === 'string' ? b['emp_code'] : '';
          const errors: Record<string, string[]> = {};
          if (!code) errors['emp_code'] = ['This field is required.'];
          else if (employees.some((e) => e.emp_code === code)) errors['emp_code'] = ['employee with this emp code already exists.'];
          if (typeof b['first_name'] !== 'string') errors['first_name'] = ['This field is required.'];
          if (typeof b['department'] !== 'number') errors['department'] = ['This field is required.'];
          if (!Array.isArray(b['area']) || b['area'].length === 0) errors['area'] = ['This field is required.'];
          if (Object.keys(errors).length > 0) return send(res, 400, errors);
          const e: MockBioTimeEmployee = { id: employees.reduce((max, x) => Math.max(max, x.id), 0) + 1, emp_code: code, first_name: String(b['first_name']), last_name: String(b['last_name'] ?? ''), card_no: String(b['card_no'] ?? ''), device_password: String(b['device_password'] ?? ''), department: b['department'] as number, area: b['area'] as number[], dev_privilege: 0 };
          employees.push(e);
          return send(res, 201, { id: e.id, emp_code: e.emp_code, first_name: e.first_name, last_name: e.last_name, department: { id: e.department }, area: e.area.map((id) => ({ id })) });
        }
      }
      const em = /^\/personnel\/api\/employees\/(\d+)\/$/.exec(path);
      if (em) {
        const idx = employees.findIndex((e) => e.id === Number(em[1]));
        if (idx < 0) return send(res, 404, { detail: 'Not found.' });
        const e = employees[idx]!;
        if (method === 'GET') return send(res, 200, { ...e, department: e.department });
        if (method === 'PATCH') {
          const b = (body ?? {}) as Record<string, unknown>;
          for (const k of ['first_name', 'last_name', 'card_no', 'device_password'] as const) if (typeof b[k] === 'string') e[k] = b[k];
          return send(res, 200, { id: e.id, emp_code: e.emp_code, first_name: e.first_name, last_name: e.last_name, department: e.department });
        }
        if (method === 'DELETE') { employees.splice(idx, 1); return send(res, 204, null); }
      }
      return send(res, 404, { detail: 'Not found.' });
    } finally {
      const i = after.findIndex((a) => a.path === path);
      if (i >= 0) { const [a] = after.splice(i, 1); a!.fn(); }
    }
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    transactions, terminals, employees, requests, tokens,
    expireTokens: () => { tokens.clear(); jwtExpiry.clear(); },
    failNext: (fault) => { faults.push({ ...fault }); },
    afterNext: (path, fn) => { after.push({ path, fn }); },
    close: () => new Promise<void>((resolveClose, reject) => { server.closeAllConnections?.(); server.close((err) => (err ? reject(err) : resolveClose())); }),
  };
}

/** `n` punches one hour apart from `start` (server-local wall time), alternating check-in/out, fingerprint/face, on `terminalSn`. */
export function bioTimeTransactionFixtures(n: number, start = '2026-03-01 08:00:00', terminalSn = 'CQZ7232460001', firstId = 1): MockBioTimeTransaction[] {
  const base = Date.parse(`${start.replace(' ', 'T')}Z`);
  const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return Array.from({ length: n }, (_, i) => ({
    id: firstId + i,
    emp_code: String(1000 + (i % 5)),
    punch_time: fmt(base + i * 3_600_000),
    punch_state: i % 2 === 0 ? '0' : '1',
    verify_type: i % 3 === 0 ? 15 : 1,
    work_code: null,
    terminal_sn: terminalSn,
    terminal_alias: 'Main gate',
    area_alias: 'HQ',
    upload_time: fmt(base + i * 3_600_000 + 30_000),
    source: 1, purpose: 9, is_attendance: 1,
    longitude: null, latitude: null, gps_location: '',
    temperature: 36.6, is_mask: 1,
  }));
}

export function bioTimeTerminalFixture(overrides: Partial<MockBioTimeTerminal> = {}): MockBioTimeTerminal {
  return {
    id: 1, sn: 'CQZ7232460001', alias: 'Main gate', ip_address: '10.0.0.21', state: 1, terminal_tz: 4, last_activity: '2026-03-02 09:58:00',
    fw_ver: 'Ver 6.60 Apr 28 2021', push_ver: '2.4.1', user_count: 120, fp_count: 230, face_count: 110, palm_count: 0, transaction_count: 5321,
    area: { id: 2, area_code: '2', area_name: 'HQ' },
    ...overrides,
  };
}
