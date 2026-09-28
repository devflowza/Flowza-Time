import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FinanceExportPunch, FinancePunchInput } from './mapping.js';

/**
 * In-process stand-in for the two Flowza Finance Edge Functions, faithful to their documented contract
 * (`supabase/functions/attendance-export/README.md` + `attendance-ingest`): serial+token auth (401 otherwise), keyset paging on
 * `(created_at, id)` with an opaque base64url cursor (unreadable → start over), `has_more`/`next_cursor`/`server_time`, and an
 * ingest endpoint that dedupes on `serial|pin|time|state`, rejects > 500 punches and reports `unmapped` PINs. Used by the provider,
 * worker and API tests — no new dependency, just `node:http`.
 */
export interface MockFinanceServerOptions {
  serial?: string;
  token?: string;
  punches?: FinanceExportPunch[];
  /** PINs Finance can map to an employee; anything else counts as `unmapped` on ingest (default: everything maps). */
  knownPins?: string[];
  /** Fixed `server_time` (default: the real clock). */
  serverTime?: () => string;
  /** Path prefix under which the functions are served (default `/functions/v1`). */
  prefix?: string;
}

export interface MockFinanceRequest { path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }
export interface MockFinanceFault { status: number; body?: unknown; headers?: Record<string, string>; times?: number; hang?: boolean; path?: 'attendance-export' | 'attendance-ingest' }

export interface MockFinanceServer {
  /** `http://127.0.0.1:<port>/functions/v1` — pass it as the connector base URL with `allowPrivateHosts: true`. */
  baseUrl: string;
  serial: string;
  token: string;
  /** Mutable: tests append punches to simulate Finance receiving new ones between pulls. */
  punches: FinanceExportPunch[];
  /** Every ingest batch accepted, in order. */
  ingested: FinancePunchInput[][];
  requests: MockFinanceRequest[];
  /** Fail the next `times` (default 1) requests with `status`; `hang` never answers (for timeout tests). */
  failNext(fault: MockFinanceFault): void;
  /** Hold the next request to `path` (any path when omitted) for `ms` before answering it normally (concurrency tests). */
  delayNext(ms: number, path?: 'attendance-export' | 'attendance-ingest'): void;
  /** Ingest dedupe keys seen so far (serial|pin|time|state → count). */
  dedupe: Map<string, number>;
  close(): Promise<void>;
}

export const encodeFinanceCursor = (createdAt: string, id: string): string => Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
const CURSOR_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeFinanceCursor(raw: unknown): { createdAt: string; id: string } | null {
  if (typeof raw !== 'string' || !CURSOR_TOKEN.test(raw)) return null;
  let text: string;
  try { text = Buffer.from(raw, 'base64url').toString('utf8'); } catch { return null; }
  const at = text.lastIndexOf('|');
  if (at < 0) return null;
  const createdAt = text.slice(0, at);
  const id = text.slice(at + 1);
  if (!TIMESTAMP_RE.test(createdAt) || !UUID_RE.test(id)) return null;
  return { createdAt, id };
}

/** Finance orders by (created_at, id); the mock uses `created_at ?? time_utc` so fixtures need not set both. */
const keyOf = (p: FinanceExportPunch): { createdAt: string; id: string } => ({ createdAt: p.created_at ?? p.time_utc, id: p.id });
const compareKeys = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number => {
  const ta = Date.parse(a.createdAt); const tb = Date.parse(b.createdAt);
  if (ta !== tb) return ta - tb;
  return a.id.toLowerCase() < b.id.toLowerCase() ? -1 : a.id.toLowerCase() > b.id.toLowerCase() ? 1 : 0;
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

export async function createMockFinanceServer(options: MockFinanceServerOptions = {}): Promise<MockFinanceServer> {
  const serial = options.serial ?? 'FLOWZA-TIME-TEST';
  const token = options.token ?? 'test-token-0123456789abcdef';
  const prefix = (options.prefix ?? '/functions/v1').replace(/\/+$/, '');
  const punches = [...(options.punches ?? [])];
  const knownPins = options.knownPins ? new Set(options.knownPins) : null;
  const serverTime = options.serverTime ?? (() => new Date().toISOString());
  const ingested: FinancePunchInput[][] = [];
  const requests: MockFinanceRequest[] = [];
  const dedupe = new Map<string, number>();
  const faults: MockFinanceFault[] = [];
  const delays: Array<{ ms: number; path?: string }> = [];

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length + 1) : url.pathname.replace(/^\/+/, '');
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const body = await readJson(req);
    requests.push({ path, body: body ?? {}, headers: req.headers });
    const delayIdx = delays.findIndex((d) => !d.path || d.path === path);
    if (delayIdx >= 0) {
      const [delay] = delays.splice(delayIdx, 1);
      await new Promise((r) => setTimeout(r, delay!.ms));
    }
    const faultIdx = faults.findIndex((f) => !f.path || f.path === path);
    if (faultIdx >= 0) {
      const fault = faults[faultIdx]!;
      if ((fault.times ?? 1) <= 1) faults.splice(faultIdx, 1); else fault.times = (fault.times ?? 1) - 1;
      if (fault.hang) return; // never answers; the client's AbortSignal decides
      return send(res, fault.status, fault.body ?? { error: `injected ${fault.status}` }, fault.headers ?? {});
    }
    if (!body) return send(res, 400, { error: 'Invalid JSON body' });
    if (body['device_serial'] !== serial || body['token'] !== token) return send(res, 401, { error: 'Unknown device or bad token' });

    if (path === 'attendance-export') {
      const limitRaw = body['limit'];
      const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) ? Math.min(1000, Math.max(1, Math.floor(limitRaw))) : 500;
      const since = body['since'] === undefined || body['since'] === null ? null : decodeFinanceCursor(body['since']);
      const ordered = [...punches].sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
      const remaining = since ? ordered.filter((p) => compareKeys(keyOf(p), since) > 0) : ordered;
      const page = remaining.slice(0, limit);
      const last = page[page.length - 1];
      return send(res, 200, {
        organization_id: '11111111-1111-4111-8111-111111111111',
        device_id: '22222222-2222-4222-8222-222222222222',
        punches: page,
        has_more: remaining.length > page.length,
        next_cursor: last ? encodeFinanceCursor(keyOf(last).createdAt, last.id) : null,
        server_time: serverTime(),
      });
    }

    if (path === 'attendance-ingest') {
      const list = body['punches'];
      if (!Array.isArray(list) || list.length === 0) return send(res, 400, { error: 'punches must be a non-empty array' });
      if (list.length > 500) return send(res, 400, { error: 'Max 500 punches per request' });
      const batch: FinancePunchInput[] = [];
      let ingestedCount = 0; let duplicates = 0; let unmapped = 0; let errors = 0;
      for (const raw of list) {
        const p = raw as Partial<FinancePunchInput>;
        if (!p || typeof p.pin !== 'string' || typeof p.time !== 'string' || Number.isNaN(Date.parse(p.time))) { errors += 1; continue; }
        const key = createHash('md5').update(`${serial}|${p.pin}|${p.time}|${p.state ?? ''}`).digest('hex');
        const seen = dedupe.get(key) ?? 0;
        dedupe.set(key, seen + 1);
        if (seen > 0) { duplicates += 1; continue; }
        if (knownPins && !knownPins.has(p.pin)) { unmapped += 1; }
        ingestedCount += 1;
        batch.push({ pin: p.pin, time: p.time, verify: p.verify ?? null, state: p.state ?? null, workcode: p.workcode ?? null, lat: p.lat ?? null, lng: p.lng ?? null, accuracy: p.accuracy ?? null });
      }
      ingested.push(batch);
      const source = typeof req.headers['x-punch-source'] === 'string' ? req.headers['x-punch-source'] : 'agent_rest';
      return send(res, 200, { ok: true, serial, source, received: list.length, ingested: ingestedCount, duplicates, unmapped, errors, skipped: 0 });
    }
    return send(res, 404, { error: `Function ${path} not found` });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`,
    serial, token, punches, ingested, requests, dedupe,
    failNext: (fault) => { faults.push({ ...fault }); },
    delayNext: (ms, path) => { delays.push({ ms, ...(path ? { path } : {}) }); },
    close: () => new Promise<void>((resolveClose, reject) => { server.closeAllConnections?.(); server.close((err) => (err ? reject(err) : resolveClose())); }),
  };
}

/** Convenience fixture: `n` Finance punches one minute apart from `start`, alternating check_in/check_out. */
export function financePunchFixtures(n: number, start = '2026-03-01T04:00:00.000Z', overrides: Partial<FinanceExportPunch> = {}): FinanceExportPunch[] {
  const base = Date.parse(start);
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(base + i * 60_000).toISOString();
    return {
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      employee_id: null,
      employee_number: `E${String(100 + i).padStart(4, '0')}`,
      pin: String(100 + i),
      device_serial: 'FIN-MOBILE',
      time_utc: at,
      device_timezone: 'Asia/Muscat',
      verify: i % 3 === 0 ? 'face' : 'mobile',
      state: i % 2 === 0 ? 'check_in' : 'check_out',
      workcode: null,
      source: 'mobile',
      lat: 23.588 + i * 0.0001, lng: 58.3829, accuracy: 12,
      geofence_verdict: 'inside', geo_flagged: false,
      created_at: at,
      ...overrides,
    };
  });
}
