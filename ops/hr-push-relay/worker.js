/**
 * hr.flowza.ai → FlowZa Time push relay (Cloudflare Worker).
 *
 * A ZKTeco/eSSL terminal has exactly ONE Cloud Server setting, and these already point at hr.flowza.ai — so FlowZa
 * cannot be added as a second destination on the device itself. This Worker sits on `hr.flowza.ai/iclock/*` and sends
 * every ADMS request to both: the existing HR system answers the terminal exactly as it does today, and FlowZa gets a
 * copy of the same bytes. Nothing on the terminals changes, and the HR system keeps its current behaviour.
 *
 * Two rules it never breaks:
 *  1. The device sees exactly one answer — the primary's. The ADMS handshake *configures* the terminal (Delay,
 *     TransTimes, stamps) and `getrequest` carries server→device commands, so two answers would fight over the device.
 *  2. The copy can never affect the terminal. It runs in `waitUntil` after the primary has answered, with its own
 *     timeout, and every failure is swallowed: a FlowZa outage must not stop punches reaching the HR system.
 *
 * Because the HR system answers while it is primary, FlowZa's own commands (push employees, restart) do NOT reach the
 * terminal in this mode — it is data capture only. Flip PRIMARY to "flowza" at cutover and that reverses: FlowZa
 * drives the device and the HR system receives the copy (until you stop mirroring to it).
 *
 * Bindings (wrangler.toml + `wrangler secret put`):
 *   FLOWZA_API      https://time-api.flowza.ai   — API_PUBLIC_URL of the FlowZa API
 *   HR_UPSTREAM     https://hr-origin.flowza.ai  — the HR system's ORIGIN hostname. Never hr.flowza.ai itself: a
 *                                                  subrequest to this Worker's own route can loop back into it.
 *   DEVICE_TOKENS   {"ZK-99887766":"<push token>"} — secret; serial → the push token FlowZa issued when you claimed
 *                                                  that device. Tokens are shown once, on claim.
 *   PRIMARY         "hr" (default) | "flowza"     — who answers the terminal.
 *   MIRROR_UNKNOWN  "true" (default) | "false"    — mirror serials with no token yet, so they surface in FlowZa as
 *                                                  pending devices ready to claim. FlowZa answers their handshakes but
 *                                                  refuses their data uploads, so nothing is stored under a serial
 *                                                  nobody has claimed.
 *   MIRROR_TO_HR    "true" (default) | "false"    — keep feeding the HR system after cutover.
 */

const PROTOCOL = 'iclock';
/** The copy is best-effort: bound it so a hanging FlowZa cannot pin a Worker invocation open. */
const MIRROR_TIMEOUT_MS = 10_000;

let cachedTokens = { raw: null, map: {} };

/** Serial → push token. Parsed once per unique secret value: this runs on every punch of every terminal. */
function deviceTokens(env) {
  const raw = env.DEVICE_TOKENS ?? '{}';
  if (cachedTokens.raw !== raw) {
    let map = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
      else console.error('DEVICE_TOKENS must be a JSON object of serial → token');
    } catch (err) {
      // Never throw: a malformed secret must degrade to "no tokens known", not take the HR system offline with it.
      console.error('DEVICE_TOKENS is not valid JSON', err instanceof Error ? err.message : err);
    }
    cachedTokens = { raw, map };
  }
  return cachedTokens.map;
}

const trimSlash = (s) => String(s ?? '').replace(/\/+$/, '');
const isOn = (v, dflt) => (v === undefined || v === '' ? dflt : String(v).toLowerCase() === 'true');

function forward(target, request, body, clientIp) {
  const headers = new Headers(request.headers);
  // Host is set by fetch for the new target, and cf-connecting-ip is the edge's to write — carrying either one over
  // makes the upstream see a request that claims to be for a host it is not serving.
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  return fetch(target, {
    method: request.method,
    headers,
    body: body ?? undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
  });
}

/** FlowZa's inbound route sits at the API root and reads the token from the path — terminals cannot send headers. */
function flowzaTarget(env, token, url) {
  const prefix = token ? `/device-push/${PROTOCOL}/~${token}` : `/device-push/${PROTOCOL}`;
  return `${trimSlash(env.FLOWZA_API)}${prefix}${url.pathname}${url.search}`;
}

const hrTarget = (env, url) => `${trimSlash(env.HR_UPSTREAM)}${url.pathname}${url.search}`;

async function quietly(label, promise) {
  try {
    const res = await promise;
    // 401 on a data upload is expected for a serial nobody has claimed in FlowZa yet; everything else is worth seeing.
    if (!res.ok) console.warn(`${label} answered ${res.status}`);
  } catch (err) {
    console.error(`${label} failed`, err instanceof Error ? err.message : err);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`/${PROTOCOL}`)) return new Response('not found', { status: 404 });
    if (!env.HR_UPSTREAM) return new Response('relay misconfigured', { status: 500 });

    // Read the body once: a stream cannot be consumed twice, and both destinations must receive identical bytes.
    // ADMS batches are small text (FlowZa caps inbound at 16 KB), so holding one in memory costs nothing.
    const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
    const clientIp = request.headers.get('cf-connecting-ip');
    const serial = url.searchParams.get('SN') ?? '';
    const token = deviceTokens(env)[serial];

    const toHr = () => forward(hrTarget(env, url), request, body, clientIp);
    const toFlowza = () => forward(flowzaTarget(env, token, url), request, body, clientIp);

    const mirrorToFlowza = !!env.FLOWZA_API && (!!token || isOn(env.MIRROR_UNKNOWN, true));
    // A terminal FlowZa has no token for cannot be driven by FlowZa, so it stays on the HR system whatever PRIMARY says
    // — otherwise turning on cutover would silently strand every device that has not been claimed yet.
    const flowzaLeads = String(env.PRIMARY ?? 'hr').toLowerCase() === 'flowza' && !!token;

    if (flowzaLeads) {
      if (isOn(env.MIRROR_TO_HR, true)) ctx.waitUntil(quietly('hr', toHr()));
      try {
        return await toFlowza();
      } catch (err) {
        console.error('flowza (primary) failed', err instanceof Error ? err.message : err);
        return new Response('upstream unavailable', { status: 502, headers: { 'content-type': 'text/plain' } });
      }
    }

    let answer;
    try {
      answer = await toHr();
    } catch (err) {
      // The terminal retries after its ErrorDelay, exactly as it would if the HR system were unreachable directly.
      console.error('hr (primary) failed', err instanceof Error ? err.message : err);
      answer = new Response('upstream unavailable', { status: 502, headers: { 'content-type': 'text/plain' } });
    }
    if (mirrorToFlowza) ctx.waitUntil(quietly('flowza', toFlowza()));
    return answer;
  },
};
