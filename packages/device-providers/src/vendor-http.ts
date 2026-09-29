import { createHash, randomBytes } from 'node:crypto';
import { EgressError, egressRequest, type EgressLookup, type EgressPolicy, type EgressResponse } from './egress.js';
import { ProviderError, type ProviderContext } from './types.js';

/**
 * Shared outbound HTTP for vendor adapters that call a server or device API (ZKBio Time, BioStar 2, Hikvision ISAPI, CrossChex
 * Cloud, COSEC device API). Every exchange:
 *  - goes through THE egress guard (`egressRequest`: https only, public hosts only, DNS pinned, no redirects, body cap, timeouts);
 *  - is throttled (`ctx.acquire()` once per HTTP request) and bounded by `ctx.signal`;
 *  - maps transport failures and HTTP statuses to ProviderError codes with GENERIC messages — never a socket code, a credential
 *    or the vendor's response body (vendor error text is logged, bounded, for operators only).
 * Adapters parse the body themselves; this module only knows HTTP.
 */

export type VendorHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface VendorHttpOptions {
  /** Local development / tests only (FLOWZA_ALLOW_PRIVATE_EGRESS): accept http:// and private hosts. */
  allowPrivateHosts?: boolean;
  /** DNS resolver of the egress guard (tests inject a fixed table; production uses the system resolver). */
  lookup?: EgressLookup;
  /** Budget for opening the TCP connection of one request (default 10 s). */
  connectTimeoutMs?: number;
  /** Budget for one whole request (default 60 s; the job's own signal still applies). */
  requestTimeoutMs?: number;
  /** Response size cap (default 4 MiB). */
  maxResponseBytes?: number;
}

export interface VendorHttpRequest {
  method: VendorHttpMethod;
  /** Absolute URL (already joined with the configured base URL). */
  url: string;
  headers?: Record<string, string>;
  /** Object bodies are sent as JSON (content-type set unless given); strings are sent verbatim. */
  body?: unknown;
  /** Label for messages/logs, e.g. `POST /api/events/search` — never contains query strings with secrets. */
  label: string;
  /** Statuses the caller wants back instead of an error (e.g. 401 for a Digest challenge, 404 for "user not found"). */
  passStatuses?: number[];
}

export interface VendorHttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  latencyMs: number;
  /** Parsed JSON body, or undefined when the body is empty or not JSON. */
  json: unknown;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** Joins a configured base URL with a path: `https://h:8081/` + `/api/x` → `https://h:8081/api/x`. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function flattenHeaders(res: EgressResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** `Retry-After` is seconds or an HTTP date; unknown/absent → a conservative minute; capped at 30 minutes. */
export function retryAfterMs(header: string | undefined, now: Date = new Date()): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30 * 60_000, Math.round(seconds * 1000));
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(30 * 60_000, Math.max(1000, at - now.getTime()));
  return DEFAULT_RETRY_AFTER_MS;
}

export class VendorHttpClient {
  readonly vendorName: string;
  private readonly egress: EgressPolicy;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxBytes: number;
  readonly allowPrivateHosts: boolean;

  constructor(vendorName: string, options: VendorHttpOptions = {}) {
    this.vendorName = vendorName;
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
    this.egress = { allowPrivate: this.allowPrivateHosts, ...(options.lookup ? { lookup: options.lookup } : {}) };
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Validates and normalises a configured base URL (https, no credentials, no query/fragment). The full egress check (DNS, public
   * addresses) runs on every request; here only the syntax is checked so the error names the field.
   */
  baseUrl(raw: unknown, field = 'baseUrl'): string {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) throw new ProviderError('INVALID_CONFIG', `${this.vendorName}: ${field} is not configured`, { retryable: false, details: { field } });
    let url: URL;
    try { url = new URL(value); } catch { throw new ProviderError('INVALID_CONFIG', `${this.vendorName}: ${field} is not a valid URL`, { retryable: false, details: { field } }); }
    if (url.username || url.password) throw new ProviderError('INVALID_CONFIG', `${this.vendorName}: ${field} must not carry credentials`, { retryable: false, details: { field } });
    if (url.protocol !== 'https:' && !(this.allowPrivateHosts && url.protocol === 'http:')) {
      throw new ProviderError('INVALID_CONFIG', `${this.vendorName}: ${field} must use https`, { retryable: false, details: { field } });
    }
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  }

  private transportError(err: unknown, label: string, signal: AbortSignal): ProviderError {
    const reason = EgressError.is(err) ? err.reason : signal.aborted ? 'timeout' : 'unreachable';
    const details = { request: label, reason };
    switch (reason) {
      case 'refused_by_policy': return new ProviderError('INVALID_CONFIG', `${this.vendorName}: the configured address is refused by the egress policy (it must be an https URL on a public host)`, { retryable: false, details });
      case 'timeout': return new ProviderError('TIMEOUT', `${this.vendorName} did not answer ${label} in time`, { retryable: true, details });
      case 'tls_error': return new ProviderError('DEVICE_OFFLINE', `${this.vendorName}: the secure connection could not be established (certificate not trusted or TLS failure)`, { retryable: true, details });
      case 'too_large': return new ProviderError('PROTOCOL_ERROR', `${this.vendorName}: ${label} response is too large`, { retryable: false, details: { ...details, maxBytes: this.maxBytes } });
      default: return new ProviderError('DEVICE_OFFLINE', `${this.vendorName} is unreachable`, { retryable: true, details: { request: label, reason: 'unreachable' } });
    }
  }

  /** One HTTP exchange; non-2xx statuses become ProviderErrors unless listed in `passStatuses`. */
  async request(ctx: ProviderContext, req: VendorHttpRequest): Promise<VendorHttpResponse> {
    const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) };
    let body: string | undefined;
    if (req.body !== undefined) {
      if (typeof req.body === 'string') body = req.body;
      else {
        body = JSON.stringify(req.body);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      }
    }
    await ctx.acquire();
    const started = Date.now();
    let res: EgressResponse;
    try {
      res = await egressRequest(req.url, { method: req.method, headers, ...(body !== undefined ? { body } : {}), signal: ctx.signal, maxBytes: this.maxBytes, connectTimeoutMs: this.connectTimeoutMs, timeoutMs: this.requestTimeoutMs }, this.egress);
    } catch (err) {
      const mapped = this.transportError(err, req.label, ctx.signal);
      ctx.logger.warn({ event: 'vendor_transport_failed', vendor: this.vendorName, request: req.label, reason: mapped.details?.['reason'], deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Vendor request failed before an HTTP answer');
      throw mapped;
    }
    const latencyMs = Date.now() - started;
    const text = res.body.toString('utf8');
    let json: unknown;
    if (text.length > 0) { try { json = JSON.parse(text); } catch { json = undefined; } }
    const out: VendorHttpResponse = { status: res.status, headers: flattenHeaders(res), text, latencyMs, json };
    if ((res.status >= 200 && res.status < 300) || req.passStatuses?.includes(res.status)) return out;
    ctx.logger.warn({ event: 'vendor_http_error', vendor: this.vendorName, request: req.label, status: res.status, vendorError: text.slice(0, 200), deviceId: ctx.deviceId, organizationId: ctx.organizationId }, 'Vendor answered with an error status');
    throw this.statusError(res.status, req.label, out.headers['retry-after']);
  }

  /** HTTP status → ProviderError (shared vocabulary; adapters may map vendor-level error codes on top). */
  statusError(status: number, label: string, retryAfter?: string): ProviderError {
    const details = { request: label, status };
    if (status >= 300 && status < 400) return new ProviderError('VENDOR_ERROR', `${this.vendorName} answered ${label} with a redirect (HTTP ${status}); redirects are not followed — check the configured URL`, { retryable: false, details });
    switch (status) {
      case 401: case 403: return new ProviderError('AUTH_FAILED', `${this.vendorName} rejected the credentials (HTTP ${status})`, { retryable: false, details });
      case 404: return new ProviderError('NOT_FOUND', `${this.vendorName}: ${label} was not found (HTTP 404) — check the URL and the server version`, { retryable: false, details });
      case 429: return new ProviderError('RATE_LIMITED', `${this.vendorName} is rate limiting requests`, { retryable: true, retryAfterMs: retryAfterMs(retryAfter), details });
      case 408: case 504: return new ProviderError('TIMEOUT', `${this.vendorName} timed out on ${label} (HTTP ${status})`, { retryable: true, details });
      case 502: case 503: return new ProviderError('DEVICE_OFFLINE', `${this.vendorName} is unavailable (HTTP ${status})`, { retryable: true, details });
      default:
        if (status >= 500) return new ProviderError('VENDOR_ERROR', `${this.vendorName} failed on ${label} (HTTP ${status})`, { retryable: true, details });
        return new ProviderError('VENDOR_ERROR', `${this.vendorName} rejected ${label} (HTTP ${status})`, { retryable: false, details });
    }
  }

  /**
   * HTTP Digest (RFC 7616, MD5 / MD5-sess, qop=auth) as used by Hikvision ISAPI and some COSEC firmware: the first request is sent
   * without credentials; a 401 with a Digest challenge is answered once. A Basic-only challenge is refused (AUTH_FAILED): the
   * password is never sent in a reversible form to a server that was expected to use Digest.
   */
  async digestRequest(ctx: ProviderContext, req: VendorHttpRequest, creds: { username: string; password: string }): Promise<VendorHttpResponse> {
    const first = await this.request(ctx, { ...req, passStatuses: [...(req.passStatuses ?? []), 401] });
    if (first.status !== 401) return first;
    const challenge = first.headers['www-authenticate'] ?? '';
    const parsed = parseDigestChallenge(challenge);
    if (!parsed) throw new ProviderError('AUTH_FAILED', `${this.vendorName} did not offer HTTP Digest authentication`, { retryable: false, details: { request: req.label, status: 401 } });
    const url = new URL(req.url);
    const authorization = buildDigestAuthorization(parsed, { method: req.method, uri: `${url.pathname}${url.search}`, username: creds.username, password: creds.password });
    const second = await this.request(ctx, { ...req, headers: { ...(req.headers ?? {}), authorization }, passStatuses: (req.passStatuses ?? []).filter((s) => s !== 401) });
    return second;
  }
}

/** HTTP Basic header value (only for vendors whose API mandates it — always over https in production). */
export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export interface DigestChallenge { realm: string; nonce: string; qop: string | null; opaque: string | null; algorithm: string }

/** Parses `WWW-Authenticate: Digest realm="…", nonce="…", qop="auth", …` (returns null for non-Digest or incomplete challenges). */
export function parseDigestChallenge(header: string): DigestChallenge | null {
  const idx = header.search(/digest\s/i);
  if (idx < 0) return null;
  const params: Record<string, string> = {};
  const re = /([a-zA-Z]+)=(?:"([^"]*)"|([^,\s]*))/g;
  for (const m of header.slice(idx + 7).matchAll(re)) params[(m[1] ?? '').toLowerCase()] = m[2] ?? m[3] ?? '';
  if (!params['realm'] && params['realm'] !== '') return null;
  if (!params['nonce']) return null;
  const qops = (params['qop'] ?? '').split(',').map((q) => q.trim()).filter(Boolean);
  const algorithm = (params['algorithm'] ?? 'MD5').toUpperCase();
  if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') return null;
  return { realm: params['realm'] ?? '', nonce: params['nonce'], qop: qops.length === 0 ? null : qops.includes('auth') ? 'auth' : null, opaque: params['opaque'] ?? null, algorithm };
}

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

/** Builds the `Authorization: Digest …` value for one request (nc=00000001, fresh cnonce). */
export function buildDigestAuthorization(ch: DigestChallenge, req: { method: string; uri: string; username: string; password: string }, cnonce: string = randomBytes(8).toString('hex')): string {
  const nc = '00000001';
  let ha1 = md5(`${req.username}:${ch.realm}:${req.password}`);
  if (ch.algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = md5(`${req.method}:${req.uri}`);
  const response = ch.qop ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${ch.qop}:${ha2}`) : md5(`${ha1}:${ch.nonce}:${ha2}`);
  const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const parts = [`username="${esc(req.username)}"`, `realm="${esc(ch.realm)}"`, `nonce="${esc(ch.nonce)}"`, `uri="${esc(req.uri)}"`, `algorithm=${ch.algorithm === 'MD5-SESS' ? 'MD5-sess' : 'MD5'}`, `response="${response}"`];
  if (ch.qop) parts.push(`qop=${ch.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (ch.opaque !== null) parts.push(`opaque="${esc(ch.opaque)}"`);
  return `Digest ${parts.join(', ')}`;
}

/** Reads a required string config/credential value, INVALID_CONFIG otherwise. */
export function requiredString(source: Record<string, unknown>, key: string, vendorName: string): string {
  const v = source[key];
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number') return String(v);
  throw new ProviderError('INVALID_CONFIG', `${vendorName}: ${key} is not configured`, { retryable: false, details: { field: key } });
}
export function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const v = source[key];
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** Wraps a DeviceProvider operation for testConnection: ProviderError → `{ ok: false }` with the safe message. */
export async function connectionProbe<T>(started: number, fn: () => Promise<T & { latencyMs?: number }>): Promise<{ ok: true; value: T } | { ok: false; message: string; latencyMs: number; details: Record<string, unknown> }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (!ProviderError.is(err)) throw err;
    return { ok: false, message: err.message, latencyMs: Date.now() - started, details: { code: err.code, retryable: err.retryable, ...(err.details ?? {}) } };
  }
}
