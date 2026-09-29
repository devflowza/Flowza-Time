import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';

/**
 * In-process stand-in for a Hikvision access-control terminal's ISAPI web service (tests only; `node:http`, no dependency),
 * faithful to the shapes reported in docs/device-integrations.md §2.2:
 *  - HTTP Digest (MD5, qop=auth) with single-use nonces and an account lockout after `lockAfter` failed answers;
 *  - `POST /ISAPI/AccessControl/AcsEvent?format=json` — AcsEventCond search (major/minor filter, inclusive time window whose
 *    bounds MUST carry an offset, ascending time order, page cap, `responseStatusStrg` OK / MORE / NO MATCH);
 *  - `UserInfo/Search|Record|Modify|Delete|Count`, `CardInfo/Record` with ISAPI ResponseStatus errors
 *    (`employeeNoAlreadyExist`, `employeeNoNotExist`, `cardNoAlreadyExist`, `badParameters`, `notSupport`);
 *  - `GET /ISAPI/System/deviceInfo`, `GET /ISAPI/System/time` (XML) and `PUT /ISAPI/System/reboot`.
 */
export interface MockIsapiEvent {
  major: number;
  minor: number;
  /** Device-local time with the device's offset, e.g. `2026-09-01T08:00:00+04:00` (ISAPI renders it that way). */
  time: string;
  serialNo: number;
  employeeNoString?: string;
  attendanceStatus?: string;
  currentVerifyMode?: string;
  /** Present on real devices; the provider must never copy them into raw payloads. */
  name?: string;
  cardNo?: string;
  pictureURL?: string;
}
export interface MockIsapiUser { employeeNo: string; name: string; userType: string; localUIRight?: boolean; Valid: { enable: boolean; beginTime: string; endTime: string }; cards: string[] }
export interface MockIsapiRequest { method: string; path: string; authorized: boolean; body: unknown }
export interface MockIsapiFault { status: number; body?: string; headers?: Record<string, string>; times?: number; path?: string }

export interface MockIsapiServerOptions {
  username?: string;
  password?: string;
  timezone?: string;
  events?: MockIsapiEvent[];
  users?: MockIsapiUser[];
  /** Records per AcsEvent / UserInfo page, whatever maxResults asks (reported: 30). */
  pageCap?: number;
  /** Failed Digest answers before the account locks (reported: ~5). */
  lockAfter?: number;
  clock?: () => Date;
  serialNumber?: string;
  model?: string;
  /** Paths (without query) answered with 403 `notSupport`. */
  unsupportedPaths?: string[];
}

export interface MockIsapiServer {
  /** `http://127.0.0.1:<port>` — the device URL (tests use `allowPrivateHosts: true`). */
  baseUrl: string;
  username: string;
  password: string;
  events: MockIsapiEvent[];
  users: Map<string, MockIsapiUser>;
  requests: MockIsapiRequest[];
  reboots: number;
  failedAuth: number;
  locked: boolean;
  /** Every AcsEventCond received (to assert offsets / paging). */
  eventSearches: Array<Record<string, unknown>>;
  failNext(fault: MockIsapiFault): void;
  /** Forget every issued nonce (the next answer to an old challenge is stale). */
  expireNonces(): void;
  close(): Promise<void>;
}

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const REALM = 'DS-K1T341AMF';
const OK = { statusCode: 1, statusString: 'OK', subStatusCode: 'ok' };
const isapiError = (statusCode: number, statusString: string, subStatusCode: string): Record<string, unknown> => ({ statusCode, statusString, subStatusCode, errorCode: 0x60000000 + statusCode, errorMsg: `${subStatusCode} (mock)` });
const xmlStatus = (code: number, text: string, sub: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<ResponseStatus version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><requestURL></requestURL><statusCode>${code}</statusCode><statusString>${text}</statusString><subStatusCode>${sub}</subStatusCode></ResponseStatus>`;

export function mockIsapiEvents(count: number, opts: { start?: string; stepSeconds?: number; firstSerial?: number; timezone?: string } = {}): MockIsapiEvent[] {
  const tz = opts.timezone ?? 'Asia/Muscat';
  const start = DateTime.fromISO(opts.start ?? '2026-09-01T08:00:00', { zone: tz });
  const minors = [0x4b, 0x01, 0x26, 0x4b];
  const statuses = ['checkIn', 'checkOut', 'breakOut', 'breakIn'];
  return Array.from({ length: count }, (_, i) => ({
    major: 5, minor: minors[i % minors.length]!, serialNo: (opts.firstSerial ?? 1000) + i,
    time: start.plus({ seconds: i * (opts.stepSeconds ?? 60) }).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ"),
    employeeNoString: `E${String(100 + (i % 7)).padStart(4, '0')}`, attendanceStatus: statuses[i % statuses.length]!, currentVerifyMode: 'cardOrFaceOrFp',
    name: 'Secret Name', cardNo: '99887766', pictureURL: 'http://10.0.0.5/picture/1.jpg',
  }));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseAuthorization(header: string | undefined): Record<string, string> | null {
  if (!header || !/^digest\s/i.test(header)) return null;
  const out: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/([a-zA-Z]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g)) out[(m[1] ?? '').toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

const ms = (iso: string): number => DateTime.fromISO(iso, { setZone: true }).toMillis();
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

export async function createMockIsapiServer(options: MockIsapiServerOptions = {}): Promise<MockIsapiServer> {
  const username = options.username ?? 'admin';
  const password = options.password ?? 'Hik-Pass 12345';
  const tz = options.timezone ?? 'Asia/Muscat';
  const cap = options.pageCap ?? 30;
  const lockAfter = options.lockAfter ?? 5;
  const clock = options.clock ?? (() => new Date());
  const nonces = new Set<string>();
  const faults: MockIsapiFault[] = [];
  const unsupported = new Set(options.unsupportedPaths ?? []);

  const state: Omit<MockIsapiServer, 'baseUrl' | 'close' | 'failNext' | 'expireNonces'> = {
    username, password, events: options.events ?? [], users: new Map((options.users ?? []).map((u) => [u.employeeNo, u])),
    requests: [], reboots: 0, failedAuth: 0, locked: false, eventSearches: [],
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const type = typeof body === 'string' ? 'application/xml; charset=UTF-8' : 'application/json; charset=UTF-8';
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(text);
  };
  const challenge = (res: ServerResponse, body = ''): void => {
    const nonce = randomBytes(16).toString('hex');
    nonces.add(nonce);
    res.writeHead(401, { 'www-authenticate': `Digest qop="auth", realm="${REALM}", nonce="${nonce}", stale="FALSE", opaque="", algorithm="MD5"`, 'content-type': 'application/xml' });
    res.end(body);
  };

  /** True when the Digest answer is valid; consumes the nonce either way (single use). */
  function authorized(req: IncomingMessage): boolean | 'none' {
    const a = parseAuthorization(req.headers.authorization);
    if (!a) return 'none';
    const nonce = a['nonce'] ?? '';
    const known = nonces.delete(nonce);
    if (!known || a['realm'] !== REALM || a['username'] !== username || a['uri'] !== req.url) return false;
    const ha1 = md5(`${username}:${REALM}:${password}`);
    const ha2 = md5(`${req.method}:${a['uri']}`);
    const expected = a['qop'] ? md5(`${ha1}:${nonce}:${a['nc']}:${a['cnonce']}:${a['qop']}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
    return a['response'] === expected;
  }

  function route(method: string, path: string, body: unknown): { status: number; body: unknown } {
    if (unsupported.has(path)) return { status: 403, body: isapiError(4, 'Invalid Operation', 'notSupport') };
    const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (method === 'GET' && path === '/ISAPI/System/deviceInfo') {
      return { status: 200, body: `<?xml version="1.0" encoding="UTF-8"?>\n<DeviceInfo version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><deviceName>Main Gate</deviceName><deviceID>a1b2</deviceID><model>${options.model ?? 'DS-K1T341AMF'}</model><serialNumber>${options.serialNumber ?? 'DS-K1T341AMF20240101V030000ENGQ12345678'}</serialNumber><macAddress>44:19:b6:00:00:01</macAddress><firmwareVersion>V3.2.30</firmwareVersion><firmwareReleasedDate>build 240101</firmwareReleasedDate><deviceType>ACS</deviceType></DeviceInfo>` };
    }
    if (method === 'GET' && path === '/ISAPI/System/time') {
      const local = DateTime.fromJSDate(clock()).setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
      return { status: 200, body: `<?xml version="1.0" encoding="UTF-8"?>\n<Time version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><timeMode>NTP</timeMode><localTime>${local}</localTime><timeZone>CST-4:00:00</timeZone></Time>` };
    }
    if (method === 'PUT' && path === '/ISAPI/System/reboot') { state.reboots += 1; return { status: 200, body: xmlStatus(1, 'OK', 'ok') }; }
    if (method === 'POST' && path === '/ISAPI/AccessControl/AcsEvent') {
      const c = obj['AcsEventCond'] as Record<string, unknown> | undefined;
      if (!c || typeof c['searchID'] !== 'string' || !Number.isInteger(c['searchResultPosition']) || !Number.isInteger(c['maxResults'])) return { status: 400, body: isapiError(6, 'Invalid Content', 'badParameters') };
      const start = String(c['startTime'] ?? ''); const end = String(c['endTime'] ?? '');
      if (!OFFSET.test(start) || !OFFSET.test(end) || !DateTime.fromISO(start).isValid || !DateTime.fromISO(end).isValid) return { status: 400, body: isapiError(6, 'Invalid Content', 'badParameters') };
      state.eventSearches.push(c);
      const major = Number(c['major'] ?? 0); const minor = Number(c['minor'] ?? 0);
      const matches = state.events
        .filter((e) => (major === 0 || e.major === major) && (minor === 0 || e.minor === minor) && ms(e.time) >= ms(start) && ms(e.time) <= ms(end))
        .sort((a, b) => ms(a.time) - ms(b.time) || a.serialNo - b.serialNo);
      const pos = c['searchResultPosition'] as number;
      const page = matches.slice(pos, pos + Math.min(cap, c['maxResults'] as number));
      const status = page.length === 0 ? 'NO MATCH' : pos + page.length < matches.length ? 'MORE' : 'OK';
      return { status: 200, body: { AcsEvent: { searchID: c['searchID'], responseStatusStrg: status, numOfMatches: page.length, totalMatches: matches.length, ...(page.length > 0 ? { InfoList: page } : {}) } } };
    }
    if (method === 'POST' && path === '/ISAPI/AccessControl/UserInfo/Search') {
      const c = obj['UserInfoSearchCond'] as Record<string, unknown> | undefined;
      if (!c || typeof c['searchID'] !== 'string' || !Number.isInteger(c['searchResultPosition']) || !Number.isInteger(c['maxResults'])) return { status: 400, body: isapiError(6, 'Invalid Content', 'badParameters') };
      const all = [...state.users.values()];
      const pos = c['searchResultPosition'] as number;
      const page = all.slice(pos, pos + Math.min(cap, c['maxResults'] as number));
      const status = page.length === 0 ? 'NO MATCH' : pos + page.length < all.length ? 'MORE' : 'OK';
      const UserInfo = page.map(({ cards, ...u }) => ({ ...u, doorRight: '1', numOfCard: cards.length, numOfFace: 0, numOfFP: 0 }));
      return { status: 200, body: { UserInfoSearch: { searchID: c['searchID'], responseStatusStrg: status, numOfMatches: page.length, totalMatches: all.length, ...(page.length > 0 ? { UserInfo } : {}) } } };
    }
    if (method === 'GET' && path === '/ISAPI/AccessControl/UserInfo/Count') return { status: 200, body: { UserInfoCount: { userNumber: state.users.size } } };
    if ((method === 'POST' && path === '/ISAPI/AccessControl/UserInfo/Record') || (method === 'PUT' && path === '/ISAPI/AccessControl/UserInfo/Modify')) {
      const u = obj['UserInfo'] as Record<string, unknown> | undefined;
      const valid = u?.['Valid'] as Record<string, unknown> | undefined;
      if (!u || typeof u['employeeNo'] !== 'string' || typeof u['name'] !== 'string' || !valid || typeof valid['beginTime'] !== 'string' || typeof valid['endTime'] !== 'string') return { status: 400, body: isapiError(6, 'Invalid Content', 'badParameters') };
      const existing = state.users.get(u['employeeNo']);
      const isRecord = path.endsWith('/Record');
      if (isRecord && existing) return { status: 400, body: isapiError(6, 'Invalid Content', 'employeeNoAlreadyExist') };
      if (!isRecord && !existing) return { status: 400, body: isapiError(6, 'Invalid Content', 'employeeNoNotExist') };
      state.users.set(u['employeeNo'], { employeeNo: u['employeeNo'], name: u['name'], userType: String(u['userType'] ?? 'normal'), localUIRight: u['localUIRight'] === true, Valid: { enable: valid['enable'] !== false, beginTime: valid['beginTime'], endTime: valid['endTime'] }, cards: existing?.cards ?? [] });
      return { status: 200, body: OK };
    }
    if (method === 'PUT' && path === '/ISAPI/AccessControl/UserInfo/Delete') {
      const cond = obj['UserInfoDelCond'] as { EmployeeNoList?: Array<{ employeeNo?: unknown }> } | undefined;
      if (!cond || !Array.isArray(cond.EmployeeNoList)) return { status: 400, body: isapiError(6, 'Invalid Content', 'badParameters') };
      for (const e of cond.EmployeeNoList) if (typeof e.employeeNo === 'string') state.users.delete(e.employeeNo);
      return { status: 200, body: OK };
    }
    if (method === 'POST' && path === '/ISAPI/AccessControl/CardInfo/Record') {
      const card = obj['CardInfo'] as Record<string, unknown> | undefined;
      if (!card || typeof card['employeeNo'] !== 'string' || typeof card['cardNo'] !== 'string') return { status: 400, body: isapiError(6, 'Invalid Content', 'badParameters') };
      const owner = state.users.get(card['employeeNo']);
      if (!owner) return { status: 400, body: isapiError(6, 'Invalid Content', 'employeeNoNotExist') };
      for (const u of state.users.values()) if (u.cards.includes(card['cardNo'])) return { status: 400, body: isapiError(6, 'Invalid Content', 'cardNoAlreadyExist') };
      owner.cards.push(card['cardNo']);
      return { status: 200, body: OK };
    }
    return { status: 404, body: xmlStatus(4, 'Invalid Operation', 'notSupport') };
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const text = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://mock');
      let body: unknown = undefined;
      if (text) { try { body = JSON.parse(text) as unknown; } catch { body = text; } }
      const entry: MockIsapiRequest = { method: req.method ?? 'GET', path: url.pathname, authorized: false, body };
      state.requests.push(entry);
      const fi = faults.findIndex((f) => f.path === undefined || f.path === url.pathname);
      const fault = fi >= 0 ? faults[fi] : undefined;
      if (fault) {
        fault.times = (fault.times ?? 1) - 1;
        if (fault.times <= 0) faults.splice(fi, 1);
        res.writeHead(fault.status, { 'content-type': 'application/json', ...(fault.headers ?? {}) });
        res.end(fault.body ?? '');
        return;
      }
      const auth = authorized(req);
      if (state.locked) { challenge(res, '<userCheck><statusValue>401</statusValue><lockStatus>locked</lockStatus><unlockTime>1800</unlockTime></userCheck>'); return; }
      if (auth === 'none') { challenge(res); return; }
      if (!auth) {
        state.failedAuth += 1;
        if (state.failedAuth >= lockAfter) state.locked = true;
        challenge(res, `<userCheck><statusValue>401</statusValue><retryLoginTime>${Math.max(0, lockAfter - state.failedAuth)}</retryLoginTime></userCheck>`);
        return;
      }
      entry.authorized = true;
      const out = route(entry.method, url.pathname, body);
      send(res, out.status, out.body);
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    baseUrl: `http://127.0.0.1:${port}`,
    failNext(fault: MockIsapiFault) { faults.push({ ...fault }); },
    expireNonces() { nonces.clear(); },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  });
}
