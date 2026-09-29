import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process stand-in for a Matrix COSEC controller's device API (`/device.cgi/...`), faithful to what the open-source clients rely on
 * (Horilla / pycosec, docs/device-integrations.md §2.7): GET-only, `format=xml` answers as `text/xml` under a `<COSEC_API>` root,
 * `<Response-Code>` for commands, repeated `<Events>` records for `events?action=getevent` (per roll-over generation, from
 * `seq-number`, at most `no-of-events`, max 100), Response-Code 10 when there is nothing, 13 for an unknown user, 21 when a reference
 * id is taken. Auth is HTTP Basic, or Digest (MD5, qop=auth, fresh nonce per challenge) for the "Digest firmware" variant.
 * Tests only — `node:http`, no dependency.
 */
export interface MockCosecEvent {
  rollOverCount: number;
  seqNo: number;
  eventId: string;
  /** dd/mm/yyyy */
  date: string;
  /** HH:mm:ss */
  time: string;
  details?: string[];
}
export interface MockCosecUser { userId: string; refUserId: string; name: string; active: string; pin?: string; card1?: string }
export interface MockCosecRequest { resource: string; action: string; query: Record<string, string>; authScheme: string | null; rawUrl: string }
export interface MockCosecFault { status: number; body?: string; headers?: Record<string, string>; times?: number }

export interface MockCosecServerOptions {
  username?: string;
  password?: string;
  auth?: 'basic' | 'digest';
  events?: MockCosecEvent[];
  /** Device wall clock for `date-time?action=get` (default 2026-03-01 08:00:00). */
  deviceClock?: () => { year: number; month: number; date: number; hour: number; minute: number; second: number };
  /** false → `getcurrentseqnumber` is answered with Response-Code 22 (firmware without the call). */
  supportsCurrentSeq?: boolean;
  /** Explicit current sequence (default: the last event's). */
  currentSeq?: { rollOverCount: number; seqNo: number };
}

export interface MockCosecServer {
  /** `http://127.0.0.1:<port>` — the controller URL (use `allowPrivateHosts: true`). */
  baseUrl: string;
  events: MockCosecEvent[];
  users: Map<string, MockCosecUser>;
  requests: MockCosecRequest[];
  options: MockCosecServerOptions;
  failNext(fault: MockCosecFault): void;
  close(): Promise<void>;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xml = (inner: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<COSEC_API>${inner}</COSEC_API>`;
const fields = (f: Record<string, string | number>): string => Object.entries(f).map(([k, v]) => `<${k}>${esc(String(v))}</${k}>`).join('');
const code = (c: number | string): string => xml(fields({ 'Response-Code': c }));
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

/** Builds `count` events on one roll-over generation: every third one a door event (208), the rest "user allowed" (101). */
export function cosecEventFixtures(count: number, opts: { roll?: number; startSeq?: number; start?: { y: number; m: number; d: number; h: number }; users?: string[] } = {}): MockCosecEvent[] {
  const roll = opts.roll ?? 0;
  const startSeq = opts.startSeq ?? 1;
  const st = opts.start ?? { y: 2026, m: 3, d: 1, h: 8 };
  const users = opts.users ?? ['1001', '1002', '1003'];
  const p = (n: number): string => String(n).padStart(2, '0');
  return Array.from({ length: count }, (_, i) => {
    const minute = i % 60;
    const hour = st.h + Math.floor(i / 60);
    const door = i % 3 === 2;
    return {
      rollOverCount: roll, seqNo: startSeq + i, eventId: door ? '208' : '101',
      date: `${p(st.d)}/${p(st.m)}/${st.y}`, time: `${p(hour % 24)}:${p(minute)}:05`,
      details: door ? ['1', '1', '0'] : [users[i % users.length] ?? '1001', String((i % 2) + 1), i % 2 === 0 ? '4' : '2', '0', '0'],
    };
  });
}

export async function createMockCosecServer(options: MockCosecServerOptions = {}): Promise<MockCosecServer> {
  const username = options.username ?? 'admin';
  const password = options.password ?? 'cosec-pass';
  const events = options.events ?? [];
  const users = new Map<string, MockCosecUser>();
  const requests: MockCosecRequest[] = [];
  const faults: MockCosecFault[] = [];
  const nonces = new Set<string>();

  const authorized = (req: IncomingMessage, method: string, rawUrl: string): boolean => {
    const header = req.headers.authorization ?? '';
    if ((options.auth ?? 'basic') === 'basic') return header === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    if (!header.startsWith('Digest ')) return false;
    const params: Record<string, string> = {};
    for (const m of header.slice(7).matchAll(/([a-z]+)=(?:"([^"]*)"|([^,\s]*))/gi)) params[(m[1] ?? '').toLowerCase()] = m[2] ?? m[3] ?? '';
    const nonce = params['nonce'] ?? '';
    if (!nonces.delete(nonce) || params['username'] !== username || params['uri'] !== rawUrl) return false; // single-use nonce
    const ha1 = md5(`${username}:COSEC:${password}`);
    const ha2 = md5(`${method}:${rawUrl}`);
    return params['response'] === md5(`${ha1}:${nonce}:${params['nc']}:${params['cnonce']}:${params['qop']}:${ha2}`);
  };

  const currentSeq = (): { rollOverCount: number; seqNo: number } => {
    if (options.currentSeq) return options.currentSeq;
    const last = [...events].sort((a, b) => a.rollOverCount - b.rollOverCount || a.seqNo - b.seqNo).pop();
    return last ? { rollOverCount: last.rollOverCount, seqNo: last.seqNo } : { rollOverCount: 0, seqNo: 0 };
  };

  const route = (resource: string, q: Record<string, string>): string => {
    const action = q['action'] ?? '';
    if (resource === 'events' && action === 'getevent') {
      const roll = Number(q['roll-over-count'] ?? 'x'), seq = Number(q['seq-number'] ?? 'x'), n = Number(q['no-of-events'] ?? '100');
      if (!Number.isInteger(roll) || !Number.isInteger(seq) || !Number.isInteger(n) || n < 1 || n > 100) return code(33);
      const page = events.filter((e) => e.rollOverCount === roll && e.seqNo >= seq).sort((a, b) => a.seqNo - b.seqNo).slice(0, n);
      if (page.length === 0) return code(10);
      return xml(page.map((e) => `<Events>${fields({ 'roll-over-count': e.rollOverCount, 'seq-No': e.seqNo, date: e.date, time: e.time, 'event-id': e.eventId, ...Object.fromEntries((e.details ?? []).map((d, i) => [`detail-${i + 1}`, d])) })}</Events>`).join(''));
    }
    if (resource === 'events' && action === 'getcurrentseqnumber') {
      if (options.supportsCurrentSeq === false) return code(22);
      const c = currentSeq();
      return xml(fields({ 'roll-over-count': c.rollOverCount, 'seq-number': c.seqNo }));
    }
    if (resource === 'device-basic-config' && action === 'get') return xml(fields({ app: 1, 'device-type': 7, name: 'Reception ARGO', 'serial-no': '64694E36B7E7', 'firmware-version': 'V3R5', 'admin-password': 'must-not-leak' }));
    if (resource === 'date-time' && action === 'get') {
      const c = options.deviceClock?.() ?? { year: 2026, month: 3, date: 1, hour: 8, minute: 0, second: 0 };
      return xml(fields({ year: c.year, month: c.month, date: c.date, hour: c.hour, minute: c.minute, second: c.second, 'time-zone': 33, 'update-mode': 1 }));
    }
    if (resource === 'command' && action === 'getusercount') return xml(fields({ 'user-count': users.size }));
    if (resource === 'users') {
      const userId = q['user-id'] ?? '';
      if (!/^[A-Za-z0-9]{1,15}$/.test(userId)) return code(33);
      if (action === 'get') {
        const u = users.get(userId);
        return u ? xml(fields({ 'user-id': u.userId, 'ref-user-id': u.refUserId, name: u.name, 'user-active': u.active, 'user-pin': u.pin ?? '', card1: u.card1 ?? '' })) : code(13);
      }
      if (action === 'delete') return users.delete(userId) ? code(0) : code(13);
      if (action === 'set') {
        const ref = q['ref-user-id'] ?? '';
        if (!/^\d{1,8}$/.test(ref)) return code(33);
        for (const u of users.values()) {
          if (u.userId !== userId && u.refUserId === ref) return code(21);
          if (u.userId !== userId && q['card1'] && u.card1 === q['card1']) return code(8);
        }
        const name = q['name'] ?? users.get(userId)?.name ?? '';
        if (Array.from(name).length > 15) return code(33);
        if (q['user-pin'] !== undefined && !/^\d{1,6}$/.test(q['user-pin'])) return code(33);
        const prev = users.get(userId);
        users.set(userId, { userId, refUserId: ref, name, active: q['user-active'] ?? prev?.active ?? '1', ...(q['user-pin'] ?? prev?.pin ? { pin: q['user-pin'] ?? prev?.pin } : {}), ...(q['card1'] ?? prev?.card1 ? { card1: q['card1'] ?? prev?.card1 } : {}) });
        return code(0);
      }
    }
    return code(22);
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, 'http://mock');
    const m = /^\/device\.cgi\/([a-z-]+)$/.exec(url.pathname);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const auth = req.headers.authorization;
    requests.push({ resource: m?.[1] ?? url.pathname, action: query['action'] ?? '', query, authScheme: auth ? (auth.split(' ')[0] ?? null) : null, rawUrl });
    const fault = faults[0];
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.times <= 0) faults.shift();
      res.writeHead(fault.status, { 'content-type': 'text/plain', ...(fault.headers ?? {}) });
      res.end(fault.body ?? 'fault');
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (!authorized(req, req.method, rawUrl)) {
      if ((options.auth ?? 'basic') === 'digest') {
        const nonce = randomBytes(12).toString('hex');
        nonces.add(nonce);
        res.writeHead(401, { 'www-authenticate': `Digest realm="COSEC", qop="auth", nonce="${nonce}", algorithm=MD5`, 'content-type': 'text/html' });
      } else {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="COSEC"', 'content-type': 'text/html' });
      }
      res.end('<html>401 Unauthorized</html>');
      return;
    }
    if (!m) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(route(m[1] ?? '', query));
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    events, users, requests, options,
    failNext: (fault) => { faults.push({ ...fault }); },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
