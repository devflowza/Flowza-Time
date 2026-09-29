import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process stand-in for a BioStar 2 / BioStar X server (tests only; `node:http`, no dependency), faithful to the official Postman
 * collection: `POST /api/login` → `bs-session-id` header; every other call needs that header (401 + `Response.code "10"` otherwise);
 * `POST /api/events/search` with `Query.{limit, conditions[{column, operator, values}], orders[{column, descending}]}` and the
 * documented operator enum (EQUAL 0 … LESS 6); `/api/users` list/detail/create/update/delete; `GET /api/devices`. Response envelopes
 * carry `Response: { code: "0", message: "Success" }`; scalars are strings, as BioStar serialises them.
 */
export interface MockBioStarEvent { id: number; datetime: string; code: number; userId?: string | null; deviceId?: string; tnaKey?: string | number }
export interface MockBioStarUser { user_id: string; name: string; disabled: string; user_group_id: { id: string; name: string }; start_datetime: string; expiry_datetime: string; pin_exists: string; pin?: string }
export interface MockBioStarDevice { id: string; name: string; status: string; device_type_id: { id: string; name: string }; version?: { firmware: string } }
export interface MockBioStarRequest { method: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, string | string[] | undefined> }
export interface MockBioStarFault { status: number; body?: unknown; headers?: Record<string, string>; times?: number; path?: string }

export interface MockBioStarServerOptions { loginId?: string; password?: string; events?: MockBioStarEvent[]; users?: MockBioStarUser[]; devices?: MockBioStarDevice[] }

export interface MockBioStarServer {
  /** `http://127.0.0.1:<port>` — use with `allowPrivateHosts: true`. */
  baseUrl: string;
  loginId: string;
  password: string;
  /** Mutable: tests append events between pulls. */
  events: MockBioStarEvent[];
  users: Map<string, MockBioStarUser>;
  devices: MockBioStarDevice[];
  requests: MockBioStarRequest[];
  /** Number of successful logins. */
  logins: number;
  /** Fail the next `times` (default 1) requests (to `path` when given) with `status` and `body`. */
  failNext(fault: MockBioStarFault): void;
  /** Invalidate every issued session (simulates the ~1 h server timeout). */
  expireSessions(): void;
  /** When true the server ignores the `id` condition (a misbehaving server). */
  ignoreIdCondition: boolean;
  close(): Promise<void>;
}

const OK = { code: '0', link: 'https://support.supremainc.com/en/support/home', message: 'Success' };
const envelope = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...extra, Response: OK });
const errorBody = (code: string, message: string): Record<string, unknown> => ({ Response: { code, message } });

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json;charset=UTF-8', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function mockBioStarUser(id: string, name: string, extra: Partial<MockBioStarUser> = {}): MockBioStarUser {
  return { user_id: id, name, disabled: 'false', user_group_id: { id: '1', name: 'All Users' }, start_datetime: '2001-01-01T00:00:00.00Z', expiry_datetime: '2030-12-31T23:59:00.00Z', pin_exists: 'false', ...extra };
}

function renderEvent(e: MockBioStarEvent): Record<string, unknown> {
  return {
    id: String(e.id),
    server_datetime: e.datetime,
    datetime: e.datetime,
    index: String(e.id),
    ...(e.userId ? { user_id: { user_id: e.userId, name: `User ${e.userId}`, photo_exists: 'false' } } : {}),
    device_id: { id: e.deviceId ?? '541531029', name: `BioStation ${e.deviceId ?? '541531029'}` },
    event_type_id: { code: String(e.code) },
    tna_key: String(e.tnaKey ?? '0'),
    user_update_by_device: 'false',
  };
}

export async function createMockBioStarServer(options: MockBioStarServerOptions = {}): Promise<MockBioStarServer> {
  const sessions = new Set<string>();
  const faults: Array<MockBioStarFault & { remaining: number }> = [];
  const state: MockBioStarServer = {
    baseUrl: '',
    loginId: options.loginId ?? 'flowza',
    password: options.password ?? 'S3cret-pass',
    events: options.events ?? [],
    users: new Map((options.users ?? []).map((u) => [u.user_id, u])),
    devices: options.devices ?? [{ id: '541531029', name: 'BioStation 2 Lobby', status: '1', device_type_id: { id: '10', name: 'BioStation 2' }, version: { firmware: '1.9.0' } }],
    requests: [],
    logins: 0,
    failNext(fault) { faults.push({ ...fault, remaining: fault.times ?? 1 }); },
    expireSessions() { sessions.clear(); },
    ignoreIdCondition: false,
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };

  const searchEvents = (body: unknown): { status: number; body: unknown } => {
    const query = asRecord(asRecord(body)['Query']);
    const limit = Number(query['limit']);
    if (!Number.isInteger(limit) || limit < 0) return { status: 400, body: errorBody('30', 'Invalid parameters') };
    let rows = [...state.events];
    for (const c of Array.isArray(query['conditions']) ? query['conditions'] : []) {
      const cond = asRecord(c);
      const values = Array.isArray(cond['values']) ? cond['values'].map(String) : [];
      const op = cond['operator'];
      const column = cond['column'];
      if (column === 'datetime' && op === 3 && values.length === 2) {
        const from = Date.parse(values[0]!); const to = Date.parse(values[1]!);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return { status: 400, body: errorBody('30', 'Invalid parameters') };
        rows = rows.filter((e) => { const t = Date.parse(e.datetime); return t >= from && t <= to; });
      } else if (column === 'id' && op === 5 && values.length === 1) {
        if (!state.ignoreIdCondition) rows = rows.filter((e) => BigInt(e.id) > BigInt(values[0]!));
      } else if (column === 'id' && op === 0 && values.length === 1) {
        rows = rows.filter((e) => String(e.id) === values[0]);
      } else if (column === 'device_id' && op === 0 && values.length === 1) {
        rows = rows.filter((e) => (e.deviceId ?? '541531029') === values[0]);
      } else {
        return { status: 400, body: errorBody('30', 'Invalid parameters') };
      }
    }
    const order = asRecord(Array.isArray(query['orders']) ? query['orders'][0] : undefined);
    if (order['column'] === 'id') rows.sort((a, b) => (order['descending'] === true ? b.id - a.id : a.id - b.id));
    const total = rows.length;
    if (limit > 0) rows = rows.slice(0, limit);
    // BioStar omits the rows array when nothing matches (the envelope alone is returned)
    return { status: 200, body: envelope(rows.length > 0 ? { EventCollection: { rows: rows.map(renderEvent), total: String(total) } } : {}) };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    state.requests.push({ method: req.method ?? 'GET', path: url.pathname, query, body, headers: req.headers });

    const faultIdx = faults.findIndex((f) => f.path === undefined || f.path === url.pathname);
    if (faultIdx >= 0) {
      const fault = faults[faultIdx]!;
      fault.remaining -= 1;
      if (fault.remaining <= 0) faults.splice(faultIdx, 1);
      send(res, fault.status, fault.body ?? errorBody('1', 'Fault'), fault.headers);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const user = asRecord(asRecord(body)['User']);
      if (user['login_id'] !== state.loginId || user['password'] !== state.password) { send(res, 401, errorBody('11', 'Login failed')); return; }
      const sid = randomBytes(16).toString('hex');
      sessions.add(sid);
      state.logins += 1;
      send(res, 200, envelope({ User: { user_id: '1', login_id: state.loginId, name: 'Administrator' } }), { 'bs-session-id': sid });
      return;
    }
    const sid = req.headers['bs-session-id'];
    if (typeof sid !== 'string' || !sessions.has(sid)) { send(res, 401, errorBody('10', 'Login required')); return; }

    if (req.method === 'POST' && url.pathname === '/api/events/search') { const r = searchEvents(body); send(res, r.status, r.body); return; }
    if (req.method === 'GET' && url.pathname === '/api/devices') {
      send(res, 200, envelope({ DeviceCollection: { total: String(state.devices.length), rows: state.devices } }));
      return;
    }
    if (url.pathname === '/api/users') {
      if (req.method === 'GET') {
        const all = [...state.users.values()].sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
        const limit = Number(query['limit'] ?? '0'); const offset = Number(query['offset'] ?? '0');
        const rows = limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset);
        send(res, 200, envelope({ UserCollection: { total: String(all.length), rows: rows.map(({ pin: _pin, ...u }) => u) } }));
        return;
      }
      if (req.method === 'POST') {
        const u = asRecord(asRecord(body)['User']);
        const id = typeof u['user_id'] === 'string' ? u['user_id'] : '';
        const name = typeof u['name'] === 'string' ? u['name'] : '';
        if (!id || !asRecord(u['user_group_id'])['id'] || !u['start_datetime'] || !u['expiry_datetime']) { send(res, 400, errorBody('30', 'Invalid parameters')); return; }
        if (state.users.has(id)) { send(res, 400, errorBody('202', 'Duplicate user id')); return; }
        if (name.length > 48 || name.includes("'")) { send(res, 400, errorBody('30', 'Invalid name')); return; }
        state.users.set(id, mockBioStarUser(id, name, { disabled: String(u['disabled'] ?? 'false'), start_datetime: String(u['start_datetime']), expiry_datetime: String(u['expiry_datetime']), user_group_id: { id: String(asRecord(u['user_group_id'])['id']), name: 'Group' }, ...(typeof u['pin'] === 'string' ? { pin: u['pin'], pin_exists: 'true' } : {}) }));
        send(res, 200, envelope({ UserCollection: { total: '1', rows: [{ user_id: id, name }] } }));
        return;
      }
      if (req.method === 'DELETE') {
        const ids = (query['id'] ?? '').split(/[+ ]/).filter(Boolean);
        if (ids.length === 0 || ids.some((i) => !state.users.has(i))) { send(res, 400, errorBody('301', 'User not found')); return; }
        for (const i of ids) state.users.delete(i);
        send(res, 200, envelope());
        return;
      }
    }
    const userMatch = /^\/api\/users\/([^/]+)$/.exec(url.pathname);
    if (userMatch) {
      const id = decodeURIComponent(userMatch[1]!);
      const existing = state.users.get(id);
      if (req.method === 'GET') {
        if (!existing) { send(res, 400, errorBody('301', 'User not found')); return; }
        const { pin: _pin, ...u } = existing;
        send(res, 200, envelope({ User: u }));
        return;
      }
      if (req.method === 'PUT') {
        if (!existing) { send(res, 400, errorBody('301', 'User not found')); return; }
        const u = asRecord(asRecord(body)['User']);
        if (!asRecord(u['user_group_id'])['id'] || !u['start_datetime'] || !u['expiry_datetime']) { send(res, 400, errorBody('30', 'Invalid parameters')); return; }
        const name = typeof u['name'] === 'string' ? u['name'] : existing.name;
        if (name.length > 48 || name.includes("'")) { send(res, 400, errorBody('30', 'Invalid name')); return; }
        state.users.set(id, { ...existing, name, disabled: String(u['disabled'] ?? existing.disabled), start_datetime: String(u['start_datetime']), expiry_datetime: String(u['expiry_datetime']), user_group_id: { ...existing.user_group_id, id: String(asRecord(u['user_group_id'])['id']) }, ...(typeof u['pin'] === 'string' ? { pin: u['pin'], pin_exists: 'true' } : {}) });
        send(res, 200, envelope());
        return;
      }
    }
    send(res, 400, errorBody('103', 'Request is not supported'));
  };

  const server: Server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, errorBody('1', 'Internal error')); }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}
