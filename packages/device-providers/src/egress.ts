import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction, type Socket } from 'node:net';

/**
 * THE egress guard for outbound calls to tenant-configured hosts (AGENTS.md "one egress helper that blocks private IP ranges and
 * cross-host redirects"). Used by the API when it validates a URL (save + test endpoint) and by the providers on every call:
 *
 *  1. syntax — https only, no userinfo, a trailing dot stripped, IP literals in every spelling classified (IPv4 decimal/hex/octal
 *     forms, IPv6 incl. v4-mapped/-compatible, NAT64, 6to4), `localhost`/`*.localhost`/`*.local`/`*.internal`/`*.lan`/… and
 *     single-label names refused;
 *  2. DNS — the host is resolved (`dns.lookup(host, { all: true })`) and refused when ANY address is not public;
 *  3. pinning — the connection is made to the address that was checked (a custom `lookup` on the request), so a DNS answer that
 *     changes between the check and the connect (rebinding) cannot reach a private address; Host header, SNI and certificate
 *     verification still use the hostname;
 *  4. no redirects, a streamed response body with a byte cap (the request is aborted once the cap is passed), connect + total
 *     timeouts.
 * Failures are reported with a GENERIC reason (`refused_by_policy` | `unreachable` | `tls_error` | `timeout` | `too_large`) —
 * never a socket error code or a response body, so a caller cannot use the error to map a network.
 * `allowPrivate` (FLOWZA_ALLOW_PRIVATE_EGRESS, local development only) skips 1's host rules and 2, and accepts http.
 */

export type EgressFailureReason = 'refused_by_policy' | 'unreachable' | 'tls_error' | 'timeout' | 'too_large';

const DEFAULT_MESSAGES: Record<EgressFailureReason, string> = {
  refused_by_policy: 'The address is not allowed: outbound calls must use https to a public host',
  unreachable: 'The host is unreachable',
  tls_error: 'The secure connection (TLS) could not be established',
  timeout: 'The host did not answer in time',
  too_large: 'The response is too large',
};

export class EgressError extends Error {
  readonly reason: EgressFailureReason;
  constructor(reason: EgressFailureReason, message?: string, options: { cause?: unknown } = {}) {
    super(message ?? DEFAULT_MESSAGES[reason], options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'EgressError';
    this.reason = reason;
  }

  static is(err: unknown): err is EgressError {
    return err instanceof EgressError || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'EgressError' && typeof (err as { reason?: unknown }).reason === 'string');
  }
}

export interface ResolvedAddress { address: string; family: 4 | 6 }
/** Resolves a hostname to every address (A and AAAA). Injectable so tests never depend on real DNS. */
export type EgressLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export const defaultEgressLookup: EgressLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

export interface EgressPolicy {
  /** Local development / tests only (FLOWZA_ALLOW_PRIVATE_EGRESS): http, private and loopback hosts allowed, no DNS vetting. */
  allowPrivate?: boolean;
  lookup?: EgressLookup;
  /** Budget for the DNS lookup (default 5 s). */
  dnsTimeoutMs?: number;
}

// ----- addresses ------------------------------------------------------------------------------------------------------------

/**
 * inet_aton-style IPv4 parser (1–4 parts, each decimal, 0x-hex or 0-octal; the last part fills the remaining bytes), so
 * `2130706433`, `0x7f.1` and `0177.0.0.1` are all 127.0.0.1. Returns null for anything that is not an IPv4 literal.
 */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isSafeInteger(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255)) return null;
  const remaining = 4 - nums.length;
  if (last >= 256 ** remaining) return null;
  const bytes = [...nums];
  for (let i = remaining - 1; i >= 0; i -= 1) bytes.push(Math.floor(last / 256 ** i) % 256);
  return bytes;
}

/** Strict IPv6 parser (after `net.isIPv6`): 16 bytes, `::` expanded, an embedded dotted IPv4 tail honoured, a zone id ignored. */
export function parseIPv6(text: string): number[] | null {
  let s = text.replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  let tail: number[] | null = null;
  if (s.includes('.')) {
    const at = s.lastIndexOf(':');
    const v4 = s.slice(at + 1);
    if (isIP(v4) !== 4) return null;
    tail = v4.split('.').map(Number);
    s = `${s.slice(0, at + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if ((halves.length === 1 && fill !== 0) || (halves.length === 2 && fill < 1)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const bytes: number[] = [];
  for (const g of groups) { const v = parseInt(g, 16); bytes.push(v >> 8, v & 0xff); }
  if (tail) bytes.splice(12, 4, ...tail);
  return bytes;
}

const inV4 = (b: number[], net: [number, number, number, number], prefix: number): boolean => {
  const addr = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const base = ((net[0] << 24) | (net[1] << 16) | (net[2] << 8) | net[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addr & mask) === (base & mask);
};

/** Non-public IPv4 ranges (RFC 6890 special-purpose registry, the ones a server-side request must never reach). */
const V4_BLOCKED: Array<[[number, number, number, number], number, string]> = [
  [[0, 0, 0, 0], 8, 'unspecified'],
  [[10, 0, 0, 0], 8, 'private'],
  [[100, 64, 0, 0], 10, 'cgnat'],
  [[127, 0, 0, 0], 8, 'loopback'],
  [[169, 254, 0, 0], 16, 'link_local'],
  [[172, 16, 0, 0], 12, 'private'],
  [[192, 0, 0, 0], 24, 'reserved'],
  [[192, 0, 2, 0], 24, 'documentation'],
  [[192, 88, 99, 0], 24, 'reserved'],
  [[192, 168, 0, 0], 16, 'private'],
  [[198, 18, 0, 0], 15, 'benchmarking'],
  [[198, 51, 100, 0], 24, 'documentation'],
  [[203, 0, 113, 0], 24, 'documentation'],
  [[224, 0, 0, 0], 4, 'multicast'],
  [[240, 0, 0, 0], 4, 'reserved'],
];

/** Why an IPv4 address is not public, or null when it is. */
export function ipv4BlockReason(bytes: number[]): string | null {
  for (const [net, prefix, reason] of V4_BLOCKED) if (inV4(bytes, net, prefix)) return reason;
  return null;
}

const zero = (b: number[], from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);

/** Why an IPv6 address is not public, or null when it is. Embedded IPv4 forms (mapped, NAT64, 6to4) are judged by their IPv4 part. */
export function ipv6BlockReason(b: number[]): string | null {
  if (zero(b, 0, 16)) return 'unspecified';
  if (zero(b, 0, 15) && b[15] === 1) return 'loopback';
  if (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return ipv4BlockReason(b.slice(12, 16)); // ::ffff:a.b.c.d
  if (zero(b, 0, 12)) return 'reserved'; // ::a.b.c.d (IPv4-compatible, deprecated)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(b, 4, 12)) return ipv4BlockReason(b.slice(12, 16)); // 64:ff9b::/96 NAT64
    return 'reserved'; // 64:ff9b:1::/48 local-use NAT64
  }
  if ((b[0]! & 0xfe) === 0xfc) return 'unique_local'; // fc00::/7 (incl. fdaa:: on Fly's private network)
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link_local'; // fe80::/10
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return 'site_local'; // fec0::/10
  if (b[0] === 0xff) return 'multicast';
  if ((b[0]! & 0xe0) !== 0x20) return 'reserved'; // outside 2000::/3 global unicast
  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0x0d && b[3] === 0xb8) return 'documentation'; // 2001:db8::/32
    if (b[2] === 0x00 && b[3] === 0x00) return 'reserved'; // 2001::/32 Teredo
    if (b[2] === 0x00 && (b[3]! & 0xf0) === 0x10) return 'reserved'; // 2001:10::/28 ORCHID
    if (b[2] === 0x00 && (b[3]! & 0xf0) === 0x20) return 'reserved'; // 2001:20::/28 ORCHIDv2
  }
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4BlockReason(b.slice(2, 6)); // 2002::/16 6to4
  return null;
}

/** Why an address literal (IPv4 in any inet_aton spelling, or IPv6 with or without brackets) is not public; null when public; `'invalid'` when it is not an address. */
export function addressBlockReason(ip: string): string | null {
  const text = ip.trim().replace(/^\[|\]$/g, '');
  if (text.includes(':')) {
    const b = parseIPv6(text);
    return b ? ipv6BlockReason(b) : 'invalid';
  }
  const v4 = parseIPv4(text);
  return v4 ? ipv4BlockReason(v4) : 'invalid';
}

export function isPublicAddress(ip: string): boolean {
  return addressBlockReason(ip) === null;
}

// ----- hostnames and URLs ----------------------------------------------------------------------------------------------------

/** Suffixes of names that only exist inside a network (never resolvable publicly). */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'localdomain', 'home.arpa', 'intranet', 'corp', 'home', 'private'];

/** Removes the brackets of an IPv6 literal and every trailing dot (`example.com.` is `example.com`). */
export function normalizeEgressHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/** Why a hostname may not be the target of an outbound call, judged WITHOUT DNS (literals, reserved names, single labels); null = allowed so far. */
export function hostnameBlockReason(hostname: string): string | null {
  const h = normalizeEgressHostname(hostname);
  if (h.length === 0) return 'empty';
  if (h.includes(':')) return addressBlockReason(h);
  if (/^[0-9a-fx.]+$/i.test(h) && parseIPv4(h)) return addressBlockReason(h);
  if (!h.includes('.')) return 'single_label';
  for (const suffix of PRIVATE_SUFFIXES) if (h === suffix || h.endsWith(`.${suffix}`)) return 'private_name';
  return null;
}

export interface EgressUrlOptions { allowPrivate?: boolean }

/**
 * Syntax half of the guard (no DNS): parses the URL, refuses userinfo, a non-https scheme (http only with `allowPrivate`) and a
 * host that is private by its spelling. Returns the URL with the hostname normalised (trailing dot removed). Throws
 * EgressError('refused_by_policy') with a message naming the rule (it describes the caller's own input, never the network).
 */
export function assertEgressUrl(raw: string | URL, opts: EgressUrlOptions = {}): URL {
  let url: URL;
  try { url = new URL(String(raw)); } catch { throw new EgressError('refused_by_policy', 'Not a valid URL'); }
  if (url.username || url.password) throw new EgressError('refused_by_policy', 'The URL must not carry credentials');
  if (url.protocol !== 'https:' && !(opts.allowPrivate && url.protocol === 'http:')) throw new EgressError('refused_by_policy', 'The URL must use https');
  const host = normalizeEgressHostname(url.hostname);
  if (host.length === 0) throw new EgressError('refused_by_policy', 'The URL has no host');
  if (!opts.allowPrivate && hostnameBlockReason(url.hostname) !== null) throw new EgressError('refused_by_policy', 'The URL must point at a public host');
  url.hostname = host.includes(':') ? `[${host}]` : host;
  return url;
}

export interface VettedUrl { url: URL; hostname: string; addresses: ResolvedAddress[] | null }

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new EgressError('timeout')); }, ms);
    const onAbort = (): void => { cleanup(); reject(new EgressError('timeout', undefined, { cause: signal?.reason })); };
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => { cleanup(); resolve(v); }, (e: unknown) => { cleanup(); reject(e); });
  });
}

/**
 * Syntax + DNS: resolves the host and refuses the URL when ANY address is not public (a name that resolves to a loopback,
 * private, link-local, CGNAT, ULA… address, e.g. `localtest.me` or `*.nip.io`). Returns the vetted addresses, IPv4 first, for
 * the pinned connection. With `allowPrivate` nothing is resolved (`addresses: null`, the transport resolves normally).
 */
export async function vetEgressUrl(raw: string | URL, policy: EgressPolicy = {}, signal?: AbortSignal): Promise<VettedUrl> {
  const url = assertEgressUrl(raw, { allowPrivate: policy.allowPrivate === true });
  const hostname = normalizeEgressHostname(url.hostname);
  if (policy.allowPrivate) return { url, hostname, addresses: null };
  const literal = isIP(hostname);
  if (literal === 4 || literal === 6) return { url, hostname, addresses: [{ address: hostname, family: literal }] };
  let addresses: ResolvedAddress[];
  try {
    addresses = await withTimeout((policy.lookup ?? defaultEgressLookup)(hostname), policy.dnsTimeoutMs ?? 5_000, signal);
  } catch (err) {
    if (EgressError.is(err)) throw err;
    throw new EgressError('unreachable', undefined, { cause: err });
  }
  if (addresses.length === 0) throw new EgressError('unreachable');
  if (addresses.some((a) => !isPublicAddress(a.address))) throw new EgressError('refused_by_policy', 'The URL must point at a public host');
  return { url, hostname, addresses: [...addresses.filter((a) => a.family === 4), ...addresses.filter((a) => a.family === 6)] };
}

// ----- transport ------------------------------------------------------------------------------------------------------------

export interface EgressRequestInit {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  /** Response bodies above this many bytes abort the request (content-length or the running count). */
  maxBytes: number;
  /** Budget for the TCP connect (default 10 s). */
  connectTimeoutMs?: number;
  /** Budget for the whole exchange, connect to last body byte (default 60 s). */
  timeoutMs?: number;
}

export interface EgressResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }

const TLS_ERROR_CODES = new Set(['EPROTO', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'HOSTNAME_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID']);

/** Socket/TLS error → generic reason. The code itself never leaves this module (it stays in the `cause`, for logs only). */
function reasonOf(err: unknown): EgressFailureReason {
  const code = String((err as { code?: unknown })?.code ?? '');
  if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || TLS_ERROR_CODES.has(code)) return 'tls_error';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  return 'unreachable';
}

/** A `lookup` that always answers the vetted address: the connection cannot follow a DNS answer that changed after the check. */
export function pinnedLookup(pin: ResolvedAddress): LookupFunction {
  return ((_hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (all) cb(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  }) as LookupFunction;
}

type Attempt = { ok: true; response: EgressResponse } | { ok: false; error: EgressError; connected: boolean };

/**
 * One HTTP(S) exchange with the connection pinned to `pin` (null = ordinary resolution, allowPrivate only). Exported for tests;
 * callers use {@link egressRequest}.
 */
export function requestPinned(url: URL, pin: ResolvedAddress | null, init: EgressRequestInit): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    const hostname = normalizeEgressHostname(url.hostname);
    const headers: Record<string, string | number> = { host: url.host, ...(init.headers ?? {}) };
    if (init.body !== undefined) headers['content-length'] = Buffer.byteLength(init.body);
    const options: RequestOptions = {
      protocol: url.protocol, hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: `${url.pathname}${url.search}`, method: init.method, headers,
      agent: false, // one connection per exchange: nothing pooled across hosts, pins or tenants
      ...(pin ? { lookup: pinnedLookup(pin), family: pin.family } : {}),
    };
    let settled = false;
    let connected = false;
    let req: ClientRequest | null = null;
    let res: IncomingMessage | null = null;
    const timers: NodeJS.Timeout[] = [];
    const finish = (attempt: Attempt): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      init.signal?.removeEventListener('abort', onAbort);
      if (!attempt.ok) { res?.destroy(); req?.destroy(); }
      resolve(attempt);
    };
    const fail = (reason: EgressFailureReason, cause?: unknown): void => finish({ ok: false, error: new EgressError(reason, undefined, { cause }), connected });
    const onAbort = (): void => fail('timeout', init.signal?.reason);
    if (init.signal?.aborted) { fail('timeout', init.signal.reason); return; }
    init.signal?.addEventListener('abort', onAbort, { once: true });
    timers.push(setTimeout(() => fail('timeout'), init.timeoutMs ?? 60_000));
    const connectTimer = setTimeout(() => { if (!connected) fail('timeout'); }, init.connectTimeoutMs ?? 10_000);
    timers.push(connectTimer);
    try {
      req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options);
    } catch (err) {
      fail('unreachable', err);
      return;
    }
    req.on('socket', (socket: Socket) => {
      const onConnect = (): void => { connected = true; clearTimeout(connectTimer); };
      if (!socket.connecting) onConnect(); else socket.once('connect', onConnect);
    });
    req.on('error', (err) => fail(reasonOf(err), err));
    req.on('response', (incoming) => {
      res = incoming;
      const status = incoming.statusCode ?? 0;
      if (status >= 300 && status < 400) { // redirects are never followed (a redirect could carry the credential elsewhere)
        finish({ ok: true, response: { status, headers: incoming.headers, body: Buffer.alloc(0) } });
        incoming.destroy();
        req?.destroy();
        return;
      }
      const declared = Number(incoming.headers['content-length']);
      if (Number.isFinite(declared) && declared > init.maxBytes) { fail('too_large'); return; }
      const chunks: Buffer[] = [];
      let total = 0;
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > init.maxBytes) { fail('too_large'); return; }
        chunks.push(chunk);
      });
      incoming.on('end', () => finish({ ok: true, response: { status, headers: incoming.headers, body: Buffer.concat(chunks, total) } }));
      incoming.on('error', (err) => fail(reasonOf(err), err));
      incoming.on('close', () => { if (!incoming.complete) fail('unreachable'); });
    });
    req.end(init.body);
  });
}

/**
 * Vets the URL (syntax + DNS), then performs the exchange pinned to a vetted address: each address is tried in turn (IPv4
 * first) while no connection could be opened to it; once a connection is up its outcome is final. Throws EgressError.
 */
export async function egressRequest(raw: string | URL, init: EgressRequestInit, policy: EgressPolicy = {}): Promise<EgressResponse> {
  const vetted = await vetEgressUrl(raw, policy, init.signal);
  const pins: Array<ResolvedAddress | null> = vetted.addresses ?? [null];
  let last: EgressError = new EgressError('unreachable');
  for (const pin of pins) {
    const attempt = await requestPinned(vetted.url, pin, init);
    if (attempt.ok) return attempt.response;
    last = attempt.error;
    if (attempt.connected || init.signal?.aborted || attempt.error.reason === 'too_large') break;
  }
  throw last;
}
