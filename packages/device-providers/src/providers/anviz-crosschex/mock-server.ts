import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';

/**
 * In-process stand-in for the CrossChex Cloud Open API (tests only; `node:http`, no new dependency), faithful to the contract the
 * research reports (docs/device-integrations.md §2.4): one `POST /` endpoint taking the `{ header, authorize, payload }` envelope,
 * `authorize.token/token` issuing a token with an ISO `expires`, `attendance.record/getrecord` filtering on `checktime` within
 * `[begin_time, end_time]` in ascending order with `page` / `per_page` (≤ 100) and `{ count, page, pageCount, list }`, and vendor
 * errors as `header { nameSpace: 'System', nameAction: 'Exception' }` + `payload { type, message }` with HTTP 200.
 * The error `type` strings are the mock's own choice (the real ones are UNKNOWN).
 */
export interface MockCrossChexRecord {
  uuid?: string | null;
  checktime: string;
  checktype?: string | number | null;
  device?: { serial_number?: string | null; name?: string | null } | null;
  employee?: { workno?: string | number | null; first_name?: string | null; last_name?: string | null } | null;
}

export interface MockCrossChexServerOptions {
  apiKey?: string;
  apiSecret?: string;
  records?: MockCrossChexRecord[];
  /** Token lifetime (default 2 h). */
  tokenTtlMs?: number;
  /** Server clock (default: the real clock). */
  now?: () => Date;
  /** Zone in which the server reads `checktime` values that carry no offset (default UTC). */
  timezone?: string;
}

export interface MockCrossChexRequest { nameSpace: string; nameAction: string; payload: Record<string, unknown>; authorize: Record<string, unknown> | null; header: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }
export interface MockCrossChexFault { status: number; body?: unknown; headers?: Record<string, string>; times?: number; nameSpace?: string }
export interface MockCrossChexException { type: string; message?: string; times?: number; nameSpace?: string }

export interface MockCrossChexServer {
  /** `http://127.0.0.1:<port>` — pass it as `baseUrlOverride` with `allowPrivateHosts: true`. */
  baseUrl: string;
  apiKey: string;
  /** Mutable: tests rotate the secret to simulate a credential change. */
  apiSecret: string;
  /** Mutable: tests append records to simulate terminals uploading new punches. */
  records: MockCrossChexRecord[];
  requests: MockCrossChexRequest[];
  /** Tokens issued so far (tests assert they never leak). */
  issuedTokens: string[];
  /** Every token issued so far becomes expired (the next authed call gets a TOKEN_EXPIRED exception). */
  expireTokens(): void;
  /** While true, every authenticated call is answered with a token exception, even for fresh tokens. */
  rejectAllTokens: boolean;
  /** Answer the next `times` (default 1) requests with an HTTP status. */
  failNext(fault: MockCrossChexFault): void;
  /** Answer the next `times` (default 1) requests with a `System/Exception` envelope. */
  exceptionNext(ex: MockCrossChexException): void;
  close(): Promise<void>;
}

const ns = (r: MockCrossChexRequest): string => `${r.nameSpace}/${r.nameAction}`;
export const isLoginRequest = (r: MockCrossChexRequest): boolean => ns(r) === 'authorize.token/token';
export const isRecordRequest = (r: MockCrossChexRequest): boolean => ns(r) === 'attendance.record/getrecord';

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const toInt = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : fallback;
};

export async function createMockCrossChexServer(options: MockCrossChexServerOptions = {}): Promise<MockCrossChexServer> {
  const now = options.now ?? (() => new Date());
  const ttl = options.tokenTtlMs ?? 2 * 3600_000;
  const zone = options.timezone ?? 'UTC';
  const tokens = new Map<string, number>(); // token → expiresAt ms
  const faults: MockCrossChexFault[] = [];
  const exceptions: MockCrossChexException[] = [];

  const instant = (checktime: string): number => {
    const dt = DateTime.fromISO(checktime.replace(' ', 'T'), { zone, setZone: false });
    return dt.isValid ? dt.toMillis() : NaN;
  };

  const state: MockCrossChexServer = {
    baseUrl: '',
    apiKey: options.apiKey ?? 'ak_test_0123456789',
    apiSecret: options.apiSecret ?? 'as_super_secret_abcdef',
    records: [...(options.records ?? [])],
    requests: [],
    issuedTokens: [],
    rejectAllTokens: false,
    expireTokens: () => { for (const t of tokens.keys()) tokens.set(t, 0); },
    failNext: (f) => { faults.push({ ...f }); },
    exceptionNext: (e) => { exceptions.push({ ...e }); },
    close: async () => undefined,
  };

  const take = <T extends { times?: number; nameSpace?: string }>(list: T[], nameSpace: string): T | undefined => {
    const idx = list.findIndex((f) => !f.nameSpace || f.nameSpace === nameSpace);
    if (idx < 0) return undefined;
    const f = list[idx]!;
    if ((f.times ?? 1) <= 1) list.splice(idx, 1); else f.times = (f.times ?? 1) - 1;
    return f;
  };

  const server: Server = createServer(async (req, res) => {
    if (req.method !== 'POST' || (req.url ?? '/').split('?')[0] !== '/') return send(res, 404, { error: 'not found' });
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'invalid json' });
    const header = obj(body['header']);
    const nameSpace = String(header['nameSpace'] ?? '');
    const nameAction = String(header['nameAction'] ?? '');
    const authorize = body['authorize'] === undefined ? null : obj(body['authorize']);
    const payload = obj(body['payload']);
    state.requests.push({ nameSpace, nameAction, payload, authorize, header, headers: req.headers });
    const envelope = (p: unknown, h: { nameSpace: string; nameAction: string } = { nameSpace, nameAction }): unknown => ({
      header: { ...h, version: '1.0', requestId: header['requestId'] ?? null, timestamp: now().toISOString() }, payload: p,
    });
    const exception = (type: string, message: string): void => send(res, 200, envelope({ type, message }, { nameSpace: 'System', nameAction: 'Exception' }));

    const fault = take(faults, nameSpace);
    if (fault) return send(res, fault.status, fault.body ?? { error: `injected ${fault.status}` }, fault.headers ?? {});
    const ex = take(exceptions, nameSpace);
    if (ex) return exception(ex.type, ex.message ?? ex.type);
    if (header['version'] !== '1.0' || typeof header['requestId'] !== 'string' || typeof header['timestamp'] !== 'string') return exception('PARAM_ERROR', 'header is incomplete');

    if (nameSpace === 'authorize.token' && nameAction === 'token') {
      if (payload['api_key'] !== state.apiKey || payload['api_secret'] !== state.apiSecret) return exception('API_KEY_ERROR', 'api_key or api_secret is invalid');
      const token = `tok_${randomBytes(12).toString('hex')}`;
      const expiresAt = now().getTime() + ttl;
      tokens.set(token, expiresAt);
      state.issuedTokens.push(token);
      return send(res, 200, envelope({ token, expires: DateTime.fromMillis(expiresAt, { zone: 'utc' }).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ") }));
    }

    // Everything else needs a live token.
    if (authorize?.['type'] !== 'token' || typeof authorize['token'] !== 'string') return exception('TOKEN_ERROR', 'token is required');
    const expiresAt = tokens.get(authorize['token']);
    if (expiresAt === undefined || state.rejectAllTokens) return exception('TOKEN_INVALID', 'token is invalid');
    if (expiresAt <= now().getTime()) return exception('TOKEN_EXPIRED', 'token has expired');

    if (nameSpace === 'attendance.record' && nameAction === 'getrecord') {
      const begin = Date.parse(String(payload['begin_time'] ?? ''));
      const end = Date.parse(String(payload['end_time'] ?? ''));
      if (!Number.isFinite(begin) || !Number.isFinite(end)) return exception('PARAM_ERROR', 'begin_time / end_time are required');
      const perPage = Math.min(100, Math.max(1, toInt(payload['per_page'], 20)));
      const page = Math.max(1, toInt(payload['page'], 1));
      const desc = payload['order'] === 'desc';
      const within = state.records
        .map((r) => ({ r, at: instant(r.checktime) }))
        .filter((x) => Number.isFinite(x.at) ? x.at >= begin && x.at <= end : true) // unreadable times are returned (tests their handling)
        .sort((a, b) => (desc ? b.at - a.at : a.at - b.at) || 0);
      const count = within.length;
      const list = within.slice((page - 1) * perPage, page * perPage).map((x) => x.r);
      return send(res, 200, envelope({ count, page, pageCount: Math.ceil(count / perPage), list }));
    }
    return exception('PARAM_ERROR', `unknown nameSpace ${nameSpace}/${nameAction}`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve, reject) => { server.closeAllConnections?.(); server.close((err) => (err ? reject(err) : resolve())); });
  return state;
}

/** `n` records one minute apart from `start` (UTC), alternating checktype 0/1, rendered with an explicit `+00:00` offset. */
export function crossChexRecordFixtures(n: number, start: string, overrides: Partial<MockCrossChexRecord> = {}, prefix = 'r'): MockCrossChexRecord[] {
  const base = Date.parse(start);
  return Array.from({ length: n }, (_, i) => ({
    uuid: `${prefix}-${String(i + 1).padStart(6, '0')}`,
    checktime: DateTime.fromMillis(base + i * 60_000, { zone: 'utc' }).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ"),
    checktype: i % 2,
    device: { serial_number: 'CXC00001', name: 'Main gate' },
    employee: { workno: String(100 + (i % 7)), first_name: 'Test', last_name: `Person ${i % 7}` },
    ...overrides,
  }));
}
