import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addressBlockReason, assertEgressUrl, EgressError, egressRequest, hostnameBlockReason, isPublicAddress, parseIPv4, parseIPv6, requestPinned, vetEgressUrl, type EgressLookup, type ResolvedAddress,
} from './egress.js';

/** A fixed DNS table: tests never depend on real resolution. Unknown names answer ENOTFOUND like the system resolver. */
function fakeDns(table: Record<string, string[]>): EgressLookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (hostname: string): Promise<ResolvedAddress[]> => {
    calls.push(hostname);
    const addrs = table[hostname];
    if (!addrs) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }) as EgressLookup & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const DNS = {
  'localtest.me': ['127.0.0.1'],
  '7f000001.nip.io': ['127.0.0.1'],
  '127.0.0.1.nip.io': ['127.0.0.1'],
  'metadata.example.com': ['169.254.169.254'],
  'fly-private.example.com': ['fdaa:0:1::3'],
  'mixed.example.com': ['104.18.38.10', '10.0.0.7'],
  'fdic.gov': ['23.41.12.9'],
  'fd.example.com': ['104.18.38.11'],
  'fc2.com': ['104.18.38.12'],
  'fe80.example.net': ['2606:4700:3030::6815:1'],
  'ucjtxdmklhhhvayirwqe.supabase.co': ['104.18.38.10', '172.64.149.246'],
};

const opened: Array<Server | TcpServer> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => new Promise<void>((r) => { (s as Server).closeAllConnections?.(); s.close(() => r()); })));
});
async function listen<S extends Server | TcpServer>(server: S, host = '127.0.0.1'): Promise<number> {
  opened.push(server);
  await new Promise<void>((r) => server.listen(0, host, () => r()));
  return (server.address() as AddressInfo).port;
}

describe('address classification', () => {
  it('reads IPv4 in every inet_aton spelling', () => {
    expect(parseIPv4('127.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4('2130706433')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4('0x7f.1')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4('0177.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4('0x7f000001')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4('127.1')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4('10.0x1.0.017')).toEqual([10, 1, 0, 15]);
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseIPv4('fdic.gov')).toBeNull();
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIPv6('[fe80::1%eth0]')?.slice(0, 2)).toEqual([0xfe, 0x80]);
    expect(parseIPv6('not-an-address')).toBeNull();
  });

  it.each([
    '127.0.0.1', '127.9.9.9', '2130706433', '0x7f.1', '0177.0.0.1', '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::127.0.0.1', 'fec0::1', 'fe80::1', 'fd00::1', 'fdaa:0:1::3', 'fc00::1', 'ff02::1',
    '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2002:7f00:1::', '2001::1', '2001:db8::1', '100::1', '[::1]',
  ])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '104.18.38.10', '172.32.0.5', '100.128.0.1', '23.41.12.9', '2606:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it('D17: the unique-local rule applies to IPv6 literals only — public names starting with fc / fd / fe80 are hostnames, not addresses', () => {
    for (const host of ['fdic.gov', 'fd.example.com', 'fc2.com', 'fe80.example.net', 'fdaa.io']) expect(hostnameBlockReason(host)).toBeNull();
    expect(hostnameBlockReason('[fd00::1]')).toBe('unique_local');
    expect(addressBlockReason('fdic.gov')).toBe('invalid');
  });
});

describe('egress URL guard (syntax + DNS)', () => {
  // the reviewer's matrix (probe-egress.mjs) plus the spellings the URL parser normalises; DNS answers come from the fake table
  it.each([
    'https://localtest.me/functions/v1', 'https://x.internal./functions/v1', 'https://intranet./functions/v1', 'https://intranet/functions/v1', 'https://db.internal./functions/v1',
    'https://metadata.google.internal./computeMetadata', 'https://app.localhost./x', 'https://printer.local./x', 'https://nas.lan./x', 'https://7f000001.nip.io/x', 'https://127.0.0.1.nip.io/x',
    'https://[fec0::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[::127.0.0.1]/x', 'https://[::1]/x', 'https://[::]/x', 'https://[fd00::1]/x', 'https://[fdaa::3]/x', 'https://[fe80::1]/x',
    'https://2130706433/x', 'https://0x7f.1/x', 'https://0177.0.0.1/x', 'https://0/x', 'https://127.0.0.1/x', 'https://127.0.0.1./x', 'https://localhost/x', 'https://LOCALHOST./x', 'https://localhost%E3%80%82/x',
    'https://ⓛⓞⓒⓐⓛⓗⓞⓢⓣ/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x', 'https://100.64.0.1/x', 'https://192.168.1.1/x', 'https://metadata.example.com/x',
    'https://fly-private.example.com/x', 'https://mixed.example.com/x', 'https://evil.com@127.0.0.1/x', 'https://user:pw@fdic.gov/x', 'http://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1',
    'ftp://fdic.gov/x', 'javascript:alert(1)', 'not a url',
  ])('refuses %s', async (url) => {
    const lookup = fakeDns(DNS);
    const err = await vetEgressUrl(url, { lookup }).catch((e: unknown) => e);
    expect(EgressError.is(err)).toBe(true);
    expect((err as EgressError).reason).toBe('refused_by_policy');
  });

  it.each([
    ['https://fdic.gov/x', 'fdic.gov'], ['https://FDIC.GOV./x', 'fdic.gov'], ['https://fd.example.com/api', 'fd.example.com'], ['https://fc2.com/x', 'fc2.com'],
    ['https://fe80.example.net/x', 'fe80.example.net'], ['https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1', 'ucjtxdmklhhhvayirwqe.supabase.co'], ['https://[2606:4700::1111]/x', '2606:4700::1111'],
  ])('allows %s', async (url, host) => {
    const vetted = await vetEgressUrl(url, { lookup: fakeDns(DNS) });
    expect(vetted.hostname).toBe(host);
    expect(vetted.addresses!.length).toBeGreaterThan(0);
    expect(vetted.addresses!.every((a) => isPublicAddress(a.address))).toBe(true);
  });

  it('strips the trailing dot, never asks DNS about a name its spelling already refuses, and lists IPv4 first', async () => {
    expect(assertEgressUrl('https://fdic.gov./x').hostname).toBe('fdic.gov');
    const lookup = fakeDns(DNS);
    await expect(vetEgressUrl('https://db.internal./x', { lookup })).rejects.toMatchObject({ reason: 'refused_by_policy' });
    expect(lookup.calls).toEqual([]);
    const both = await vetEgressUrl('https://dual.example.com/x', { lookup: fakeDns({ 'dual.example.com': ['2606:4700::1', '104.18.0.1'] }) });
    expect(both.addresses!.map((a) => a.family)).toEqual([4, 6]);
  });

  it('reports an unresolvable host as unreachable (a DNS error code never surfaces) and the local-development flag skips every check', async () => {
    const err = (await vetEgressUrl('https://no-such-host.example.com/x', { lookup: fakeDns({}) }).catch((e: unknown) => e)) as EgressError;
    expect(err.reason).toBe('unreachable');
    expect(err.message).not.toMatch(/ENOTFOUND|getaddrinfo/);
    const lookup = fakeDns({});
    const dev = await vetEgressUrl('http://127.0.0.1:8080/functions/v1', { allowPrivate: true, lookup });
    expect(dev).toMatchObject({ hostname: '127.0.0.1', addresses: null });
    expect(lookup.calls).toEqual([]);
  });
});

describe('pinned transport', () => {
  it('connects to the vetted address — never re-resolving the name — while the Host header keeps the hostname', async () => {
    const seen: Array<{ host: string | undefined; remote: string | undefined }> = [];
    const port = await listen(createHttpServer((req, res) => { seen.push({ host: req.headers.host, remote: req.socket.remoteAddress }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }));
    // `finance.flowza.invalid` does not resolve anywhere: the exchange can only succeed through the pin
    const attempt = await requestPinned(new URL(`http://finance.flowza.invalid:${port}/functions/v1/attendance-export`), { address: '127.0.0.1', family: 4 }, { method: 'POST', body: '{}', maxBytes: 1024 });
    expect(attempt.ok).toBe(true);
    expect(attempt.ok && attempt.response.status).toBe(200);
    expect(seen).toEqual([{ host: `finance.flowza.invalid:${port}`, remote: '127.0.0.1' }]);
  });

  it('keeps TLS SNI = the hostname on a pinned connection', async () => {
    let hello = Buffer.alloc(0);
    const port = await listen(createTcpServer((socket) => { socket.once('data', (chunk: Buffer) => { hello = chunk; socket.destroy(); }); }));
    const attempt = await requestPinned(new URL(`https://finance.flowza.test:${port}/functions/v1/attendance-export`), { address: '127.0.0.1', family: 4 }, { method: 'POST', body: '{}', maxBytes: 1024, timeoutMs: 5_000 });
    expect(attempt.ok).toBe(false);
    expect(hello[0]).toBe(0x16); // a TLS handshake record reached the pinned address …
    expect(hello.includes(Buffer.from('finance.flowza.test', 'ascii'))).toBe(true); // … carrying the hostname as SNI
  });

  it('DNS rebinding: the name is resolved once, and the connection never follows a later answer to a private address', async () => {
    let requests = 0;
    const port = await listen(createHttpServer((_req, res) => { requests += 1; res.end('{}'); }));
    const calls: string[] = [];
    const rebinding: EgressLookup = async (hostname) => {
      calls.push(hostname);
      return calls.length === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
    };
    const err = await egressRequest(`https://rebind.flowza.test:${port}/x`, { method: 'POST', body: '{}', maxBytes: 1024, connectTimeoutMs: 300, timeoutMs: 2_000 }, { lookup: rebinding }).catch((e: unknown) => e);
    expect(EgressError.is(err)).toBe(true);
    expect(['unreachable', 'timeout', 'tls_error']).toContain((err as EgressError).reason);
    expect(calls).toEqual(['rebind.flowza.test']);
    expect(requests).toBe(0);
  });

  it('refuses a name that resolves to a loopback address before opening any connection (localtest.me)', async () => {
    let connections = 0;
    const port = await listen(createTcpServer((s) => { connections += 1; s.destroy(); }));
    const err = await egressRequest(`https://localtest.me:${port}/functions/v1/attendance-export`, { method: 'POST', body: '{}', maxBytes: 1024 }, { lookup: fakeDns(DNS) }).catch((e: unknown) => e);
    expect((err as EgressError).reason).toBe('refused_by_policy');
    expect(connections).toBe(0);
  });

  it('never follows a redirect', async () => {
    let followed = 0;
    const target = await listen(createHttpServer((_req, res) => { followed += 1; res.end('{}'); }));
    const port = await listen(createHttpServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target}/steal` }); res.end(); }));
    const res = await egressRequest(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}', maxBytes: 1024 }, { allowPrivate: true });
    expect(res.status).toBe(302);
    expect(followed).toBe(0);
  });

  it('maps socket failures to generic reasons: a closed port is unreachable, a non-TLS port is tls_error — no socket codes in the message', async () => {
    const closed = await listen(createTcpServer(() => undefined));
    const closedPort = closed;
    await new Promise<void>((r) => opened.pop()!.close(() => r()));
    const refused = (await egressRequest(`http://127.0.0.1:${closedPort}/x`, { method: 'GET', maxBytes: 1024 }, { allowPrivate: true }).catch((e: unknown) => e)) as EgressError;
    expect(refused.reason).toBe('unreachable');
    const plain = await listen(createHttpServer((_req, res) => res.end('{}')));
    const tls = (await egressRequest(`https://127.0.0.1:${plain}/x`, { method: 'GET', maxBytes: 1024 }, { allowPrivate: true }).catch((e: unknown) => e)) as EgressError;
    expect(tls.reason).toBe('tls_error');
    for (const e of [refused, tls]) expect(e.message).not.toMatch(/ECONN|ERR_|EPROTO|SSL|packet/i);
  });

  it('times out a server that never answers', async () => {
    const port = await listen(createHttpServer(() => undefined));
    const started = Date.now();
    const err = (await egressRequest(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}', maxBytes: 1024, timeoutMs: 200 }, { allowPrivate: true }).catch((e: unknown) => e)) as EgressError;
    expect(err.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('D2 — the response cap is enforced while streaming', () => {
  const MB = 1024 * 1024;
  function streamingServer(totalMb: number, declareLength: boolean): { server: Server; sent: () => number } {
    let sent = 0;
    const chunk = Buffer.alloc(MB, 0x61);
    const server = createHttpServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', ...(declareLength ? { 'content-length': String(totalMb * MB) } : {}) });
      let i = 0;
      const pump = (): void => {
        while (i < totalMb) {
          i += 1;
          sent += MB;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      res.on('close', () => { i = totalMb; });
      pump();
    });
    return { server, sent: () => sent };
  }

  it('aborts a 20 MB streamed body once 16 MB have arrived (too_large, bounded memory)', async () => {
    const s = streamingServer(20, false);
    const port = await listen(s.server);
    const before = process.memoryUsage().rss;
    const err = (await egressRequest(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}', maxBytes: 16 * MB }, { allowPrivate: true }).catch((e: unknown) => e)) as EgressError;
    expect(EgressError.is(err)).toBe(true);
    expect(err.reason).toBe('too_large');
    expect(process.memoryUsage().rss - before).toBeLessThan(64 * MB);
  });

  it('stops reading a 200 MB stream at the cap: the server never gets to send the rest and memory stays bounded (was +623 MB)', async () => {
    const s = streamingServer(200, false);
    const port = await listen(s.server);
    const before = process.memoryUsage().rss;
    const err = (await egressRequest(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}', maxBytes: 16 * MB }, { allowPrivate: true }).catch((e: unknown) => e)) as EgressError;
    expect(err.reason).toBe('too_large');
    expect(s.sent()).toBeLessThan(100 * MB);
    expect(process.memoryUsage().rss - before).toBeLessThan(96 * MB);
  });

  it('refuses on a declared content-length above the cap without reading the body', async () => {
    const s = streamingServer(20, true);
    const port = await listen(s.server);
    const err = (await egressRequest(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}', maxBytes: 16 * MB }, { allowPrivate: true }).catch((e: unknown) => e)) as EgressError;
    expect(err.reason).toBe('too_large');
    expect(s.sent()).toBeLessThan(16 * MB);
  });
});
