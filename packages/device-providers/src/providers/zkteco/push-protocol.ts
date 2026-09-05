import { z } from 'zod';
import { deviceEmployeeSchema, type DeviceEmployee, type PunchDirection, type RawTransaction, type VerificationMethod } from '@flowza/contracts';
import { ProtocolError } from '../../errors.js';
import { assertBodySize, boundedText, parseDeviceTime, queryValue, splitLines, toIsoUtc } from '../../protocol-utils.js';
import { ProviderError, type DeviceInfo, type DevicePushCommand, type DevicePushInbound, type DevicePushParseContext, type DevicePushProtocolHandler, type DevicePushRequest, type DevicePushResponse } from '../../types.js';

/**
 * ZKTeco PUSH / ADMS ("iclock") protocol handler.
 *
 * VERIFICATION STATUS: REPORTED. Every field mapping below (verify codes, status codes, handshake options,
 * command grammar, stamp semantics) is taken from publicly available descriptions of the PUSH SDK protocol and
 * open-source server implementations, NOT from vendor documentation or hardware tests. Confirm on real
 * terminals (and per firmware family) before promoting the provider from `beta`; record findings in
 * docs/device-integrations.md.
 *
 * Flow (device → FlowZa, all HTTP/1.1 text/plain):
 *  1. `GET /iclock/cdata?SN=<sn>&options=all&pushver=…`   handshake → we answer the option block.
 *  2. `POST /iclock/cdata?SN=<sn>&table=ATTLOG&Stamp=<s>`  tab-separated punches → `OK: <n>`.
 *     `POST /iclock/cdata?SN=<sn>&table=OPERLOG&OpStamp=…` operation log; `USER PIN=…` lines describe users.
 *     Biometric template lines (FP/FACE/BIOPHOTO/USERPIC) are ignored and never stored.
 *  3. `GET /iclock/getrequest?SN=<sn>[&INFO=…]`            device polls for commands → `OK` or `C:<id>:<cmd>` lines.
 *  4. `POST /iclock/devicecmd?SN=<sn>` body `ID=<id>&Return=<code>&CMD=<cmd>` → command results.
 *
 * Stamps: `ATTLOGStamp`/`OPERLOGStamp` in the handshake tell the device which records it may skip. The handler
 * is stateless; the route persists the `Stamp` seen on ATTLOG/OPERLOG posts (returned in `meta`) and feeds it back
 * through `ctx.stamps`. Without stamps we answer `None`, which (reportedly) makes the device resend everything —
 * safe because raw ingestion is idempotent (dedupe hash).
 */
export const ICLOCK_PROTOCOL_KEY = 'iclock';

export interface ZkPushProtocolOptions {
  /** Seconds the device waits after an error before retrying (handshake `ErrorDelay`). */
  errorDelay?: number;
  /** Seconds between `getrequest` polls (handshake `Delay`). */
  delay?: number;
  /** Daily times at which the device uploads its full log (handshake `TransTimes`, `HH:mm;HH:mm`). */
  transTimes?: string;
  /** Minutes between incremental uploads (handshake `TransInterval`). */
  transInterval?: number;
  /** Ask the device to push events in real time (handshake `Realtime`). */
  realtime?: boolean;
}
const DEFAULT_OPTIONS: Required<ZkPushProtocolOptions> = { errorDelay: 30, delay: 10, transTimes: '00:00;14:05', transInterval: 1, realtime: true };

/** REPORTED: ATTLOG `Verify` column → verification method. Unlisted codes map to `unknown`. */
export const ZK_VERIFY_METHODS: Readonly<Record<number, VerificationMethod>> = { 0: 'password', 1: 'fingerprint', 2: 'card', 15: 'face' };
/** REPORTED: ATTLOG `Status` column → punch direction. Unlisted codes (e.g. 255) map to `unknown`. */
export const ZK_STATUS_DIRECTIONS: Readonly<Record<number, PunchDirection>> = { 0: 'in', 1: 'out', 2: 'break_out', 3: 'break_in', 4: 'overtime_in', 5: 'overtime_out' };
/** REPORTED: USER `Pri` values that denote device administrators (6 = administrator, 14 = super administrator). */
export const ZK_ADMIN_PRIVILEGES: ReadonlySet<number> = new Set([6, 14]);
export const ZK_PRI_USER = 0;
export const ZK_PRI_ADMIN = 14;
/** REPORTED: default access group / time-zone string for pushed users. */
export const ZK_DEFAULT_GROUP = 1;
export const ZK_DEFAULT_TZ = '0000000100000000';

const SERIAL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PIN_PATTERN = /^[0-9A-Za-z]{1,24}$/; // REPORTED: PINs are numeric on most firmware (<= 9 digits); alphanumerics accepted defensively
const PASSWD_PATTERN = /^\d{1,8}$/;
const CARD_PATTERN = /^\d{1,20}$/;
const STAMP_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARS = /\p{Cc}/gu;
const NAME_MAX = 24;
const TAB = '\t';
/** Raw-payload budget (§ raw payload allowlist, 16 KB cap): at most this many trailing ATTLOG columns are kept … */
const MAX_RESERVED_FIELDS = 8;
/** … and every free-text vendor field is cut at this length. */
const MAX_RAW_FIELD = 64;

type IclockRoute = 'cdata' | 'getrequest' | 'devicecmd' | 'registry' | 'push' | 'ping' | 'querydata';
const ROUTES: ReadonlySet<string> = new Set<IclockRoute>(['cdata', 'getrequest', 'devicecmd', 'registry', 'push', 'ping', 'querydata']);

export function iclockRoute(path: string): IclockRoute | null {
  const clean = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  const last = clean.slice(clean.lastIndexOf('/') + 1).toLowerCase();
  return ROUTES.has(last) ? (last as IclockRoute) : null;
}

const text = (body: string, status = 200): DevicePushResponse => ({ status, body, headers: { 'content-type': 'text/plain; charset=utf-8' } });

function serialOf(req: DevicePushRequest): string | null {
  const sn = queryValue(req.query, 'SN');
  return sn !== undefined && SERIAL_PATTERN.test(sn) ? sn : null;
}
function intField(value: string | undefined, name: string, line: number): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^-?\d{1,10}$/.test(value)) throw new ProtocolError(`ATTLOG line ${line}: ${name} must be an integer`, { details: { line, field: name } });
  return Number(value);
}

/** Parses one `PIN\tYYYY-MM-DD HH:MM:SS\tStatus\tVerify\tWorkCode\tReserved…` line (REPORTED layout). */
export function parseAttlogLine(line: string, index: number, timezone: string, serialNumber: string): RawTransaction {
  const n = index + 1;
  const parts = line.split(TAB).map((p) => p.trim());
  if (parts.length < 2) throw new ProtocolError(`ATTLOG line ${n}: expected at least PIN and time separated by tabs`, { details: { line: n, fields: parts.length } });
  const [pin = '', time = '', statusRaw, verifyRaw, workCode = '', ...reserved] = parts;
  if (!PIN_PATTERN.test(pin)) throw new ProtocolError(`ATTLOG line ${n}: invalid PIN`, { details: { line: n } });
  const at = parseDeviceTime(time, timezone);
  const status = intField(statusRaw, 'Status', n);
  const verify = intField(verifyRaw, 'Verify', n);
  // Unknown trailing columns are kept for diagnostics but bounded: a firmware (or attacker) appending kilobytes
  // per line must not inflate raw_payload beyond the 16 KB budget or smuggle binary data into the database.
  const truncated = reserved.length > MAX_RESERVED_FIELDS || workCode.length > MAX_RAW_FIELD || reserved.some((f) => f.length > MAX_RAW_FIELD);
  const boundedReserved = reserved.slice(0, MAX_RESERVED_FIELDS).map((f) => f.slice(0, MAX_RAW_FIELD));
  return {
    providerTransactionId: null, // the device has no stable record id; the ingestion dedupe hash applies
    deviceEmployeeId: pin,
    punchedAt: toIsoUtc(at),
    deviceLocalTime: time,
    verificationMethod: verify !== undefined ? ZK_VERIFY_METHODS[verify] ?? 'unknown' : 'unknown',
    direction: status !== undefined ? ZK_STATUS_DIRECTIONS[status] ?? 'unknown' : 'unknown',
    rawPayload: {
      protocol: ICLOCK_PROTOCOL_KEY, table: 'ATTLOG', serialNumber, pin, time, status: status ?? null, verify: verify ?? null,
      workCode: workCode.slice(0, MAX_RAW_FIELD), reserved: boundedReserved, ...(truncated ? { truncated: true } : {}),
    },
  };
}

function kvPairs(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const eq = f.indexOf('=');
    if (eq <= 0) continue;
    out[f.slice(0, eq).trim()] = f.slice(eq + 1).trim();
  }
  return out;
}
const sanitizeName = (name: string): string => name.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();

/** Parses a `USER PIN=…\tName=…\tPri=…\tPasswd=…\tCard=…\tGrp=…\tTZ=…` line into a DeviceEmployee (REPORTED layout). */
export function parseOperlogUserLine(line: string, index: number): DeviceEmployee {
  const n = index + 1;
  const body = line.replace(/^USER\s+/i, '');
  const kv = kvPairs(body.split(TAB));
  const pin = kv.PIN ?? '';
  if (!PIN_PATTERN.test(pin)) throw new ProtocolError(`OPERLOG line ${n}: USER record without a valid PIN`, { details: { line: n } });
  const pri = kv.Pri !== undefined && /^\d{1,3}$/.test(kv.Pri) ? Number(kv.Pri) : ZK_PRI_USER;
  const name = sanitizeName(kv.Name ?? '');
  const card = kv.Card !== undefined && kv.Card !== '' && kv.Card !== '0' && CARD_PATTERN.test(kv.Card) ? kv.Card : null;
  const passwd = kv.Passwd !== undefined && kv.Passwd !== '' && PASSWD_PATTERN.test(kv.Passwd) ? kv.Passwd : null;
  return {
    deviceUserId: pin,
    name: name.length > 0 ? name : pin,
    cardNumber: card,
    pin: passwd,
    privilege: ZK_ADMIN_PRIVILEGES.has(pri) ? 'admin' : 'user',
    enabled: true,
    photoUrl: null,
    extra: { protocol: ICLOCK_PROTOCOL_KEY, pri, grp: boundedText(kv.Grp, MAX_RAW_FIELD), tz: boundedText(kv.TZ, MAX_RAW_FIELD), verify: boundedText(kv.Verify, MAX_RAW_FIELD) },
  };
}

/** Returns users found in an OPERLOG body; template/photo/op lines are counted and dropped, never stored. */
export function parseOperlogBody(body: string): { employees: DeviceEmployee[]; lines: number; ignored: number } {
  const lines = splitLines(body);
  const employees: DeviceEmployee[] = [];
  let ignored = 0;
  lines.forEach((line, i) => {
    if (/^USER\s/i.test(line)) employees.push(parseOperlogUserLine(line, i));
    else ignored += 1; // OPLOG / FP / FACE / BIOPHOTO / USERPIC / BIODATA … — biometric data is intentionally discarded
  });
  return { employees, lines: lines.length, ignored };
}

/** Parses `ID=<id>&Return=<code>&CMD=<cmd>` lines posted to /iclock/devicecmd (REPORTED layout). */
export function parseDeviceCmdBody(body: string): NonNullable<DevicePushInbound['commandResults']> {
  return splitLines(body).map((line, i) => {
    const kv = kvPairs(line.split('&'));
    const id = kv.ID ?? '';
    if (!COMMAND_ID_PATTERN.test(id)) throw new ProtocolError(`devicecmd line ${i + 1}: missing or invalid ID`, { details: { line: i + 1 } });
    const ret = kv.Return;
    if (ret === undefined || !/^-?\d{1,10}$/.test(ret)) throw new ProtocolError(`devicecmd line ${i + 1}: missing or invalid Return code`, { details: { line: i + 1 } });
    const code = Number(ret);
    return { commandId: id, ok: code === 0, message: `Return=${code}${kv.CMD ? ` CMD=${kv.CMD}` : ''}` };
  });
}

/** REPORTED: `INFO=<firmware>,<userCount>,<fpCount>,<attCount>,<ip>,…` sent by some firmware on getrequest. */
export function parseInfoParam(info: string | undefined): Partial<DeviceInfo> | undefined {
  if (info === undefined || info.length === 0) return undefined;
  const parts = info.split(',').map((p) => p.trim());
  const num = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,10}$/.test(v) ? Number(v) : undefined);
  const out: Partial<DeviceInfo> = { extra: { info: parts } };
  if (parts[0]) out.firmwareVersion = parts[0];
  const users = num(parts[1]); if (users !== undefined) out.userCount = users;
  const fps = num(parts[2]); if (fps !== undefined) out.fingerprintCount = fps;
  const att = num(parts[3]); if (att !== undefined) out.transactionCount = att;
  return out;
}

function stampOf(stamps: Record<string, string> | undefined, key: string): string {
  const v = stamps?.[key];
  return v !== undefined && STAMP_PATTERN.test(v) ? v : 'None';
}

/** Option block returned on the handshake (REPORTED format). Templates/photos are excluded from TransFlag on purpose. */
export function renderHandshake(serialNumber: string, stamps: Record<string, string> | undefined, options: Required<ZkPushProtocolOptions>): string {
  return [
    `GET OPTION FROM: ${serialNumber}`,
    `ATTLOGStamp=${stampOf(stamps, 'ATTLOG')}`,
    `OPERLOGStamp=${stampOf(stamps, 'OPERLOG')}`,
    'ATTPHOTOStamp=None',
    `ErrorDelay=${options.errorDelay}`,
    `Delay=${options.delay}`,
    `TransTimes=${options.transTimes}`,
    `TransInterval=${options.transInterval}`,
    `TransFlag=TransData AttLog${TAB}OpLog${TAB}EnrollUser${TAB}ChgUser`,
    `Realtime=${options.realtime ? 1 : 0}`,
    'Encrypt=None',
  ].join('\n') + '\n';
}

// ----- outbound commands ------------------------------------------------------------------------------------
/** Protocol-ready payload persisted in device_commands (what `buildCommands` emits and `renderCommands` reads back). */
const persistedUserPayloadSchema = z.object({
  pin: z.string(), name: z.string(), pri: z.number().int(), passwd: z.string(), card: z.string(), grp: z.number().int(), tz: z.string(),
});
export type ZkUserCommandPayload = z.infer<typeof persistedUserPayloadSchema>;
const employeePayloadSchema = deviceEmployeeSchema.pick({ deviceUserId: true, name: true, cardNumber: true, pin: true, privilege: true })
  .transform((e): ZkUserCommandPayload => ({ pin: e.deviceUserId, name: sanitizeName(e.name), pri: e.privilege === 'admin' ? ZK_PRI_ADMIN : ZK_PRI_USER, passwd: e.pin ?? '', card: e.cardNumber ?? '', grp: ZK_DEFAULT_GROUP, tz: ZK_DEFAULT_TZ }));

function invalid(message: string, details: Record<string, unknown>): ProviderError {
  return new ProviderError('INVALID_CONFIG', message, { retryable: false, details });
}
/** Accepts either the persisted protocol payload or a DeviceEmployee; every field is re-validated before rendering. */
function userPayload(input: unknown): ZkUserCommandPayload {
  const persisted = persistedUserPayloadSchema.safeParse(input);
  const parsed = persisted.success ? persisted : employeePayloadSchema.safeParse(input);
  if (!parsed.success) throw invalid('Employee cannot be pushed to a ZKTeco device', { issues: parsed.error.issues.map((i) => i.message) });
  const p = { ...parsed.data, name: sanitizeName(parsed.data.name) };
  if (!Number.isInteger(p.pri) || p.pri < 0 || p.pri > 14) throw invalid('ZKTeco Pri must be 0-14', { deviceUserId: p.pin });
  if (!/^[0-9]{16}$/.test(p.tz)) throw invalid('ZKTeco TZ must be 16 digits', { deviceUserId: p.pin });
  if (!Number.isInteger(p.grp) || p.grp < 0) throw invalid('ZKTeco Grp must be a non-negative integer', { deviceUserId: p.pin });
  if (!PIN_PATTERN.test(p.pin)) throw invalid('ZKTeco PIN must be 1-24 alphanumeric characters (numeric on most firmware)', { deviceUserId: p.pin });
  if (p.passwd !== '' && !PASSWD_PATTERN.test(p.passwd)) throw invalid('ZKTeco password must be 1-8 digits', { deviceUserId: p.pin });
  if (p.card !== '' && !CARD_PATTERN.test(p.card)) throw invalid('ZKTeco card number must be 1-20 digits', { deviceUserId: p.pin });
  if (p.name.length === 0) throw invalid('Employee name is empty after sanitising', { deviceUserId: p.pin });
  return p;
}
function pinPayload(input: unknown): string {
  const pin = typeof input === 'object' && input !== null ? (input as { deviceUserId?: unknown }).deviceUserId : undefined;
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) throw invalid('DELETE_EMPLOYEE payload requires a valid deviceUserId', {});
  return pin;
}

/** Renders one pending command as a `C:<id>:<command>` line (REPORTED grammar). */
export function renderCommandLine(cmd: DevicePushCommand): string {
  if (!COMMAND_ID_PATTERN.test(cmd.id)) throw invalid('Command id must be 1-64 characters [A-Za-z0-9_-]', { id: cmd.id });
  switch (cmd.commandType) {
    case 'UPSERT_EMPLOYEE': {
      const u = userPayload(cmd.payload);
      return `C:${cmd.id}:DATA UPDATE USERINFO PIN=${u.pin}${TAB}Name=${u.name}${TAB}Pri=${u.pri}${TAB}Passwd=${u.passwd}${TAB}Card=${u.card}${TAB}Grp=${u.grp}${TAB}TZ=${u.tz}`;
    }
    case 'DELETE_EMPLOYEE': return `C:${cmd.id}:DATA DELETE USERINFO PIN=${pinPayload(cmd.payload)}`;
    case 'RESTART': return `C:${cmd.id}:REBOOT`;
    case 'QUERY_USERS': return `C:${cmd.id}:DATA QUERY USERINFO`;
    default: throw new ProviderError('UNSUPPORTED', `Command type ${cmd.commandType} is not supported by the iclock protocol`, { retryable: false, details: { commandType: cmd.commandType } });
  }
}

let defaultHandler: DevicePushProtocolHandler | undefined;

/**
 * Creates the iclock handler. With no options the same shared instance is returned every time, so every
 * ZKTeco-derived provider (zkteco_push, essl_push, fingertec_push) exposes one handler and the registry can
 * route `/device-push/iclock/*` unambiguously.
 */
export function createZkPushProtocol(options?: ZkPushProtocolOptions): DevicePushProtocolHandler {
  if (options === undefined) {
    defaultHandler ??= buildZkPushProtocol({});
    return defaultHandler;
  }
  return buildZkPushProtocol(options);
}

function buildZkPushProtocol(options: ZkPushProtocolOptions): DevicePushProtocolHandler {
  const opts: Required<ZkPushProtocolOptions> = { ...DEFAULT_OPTIONS, ...options };
  return {
    protocolKey: ICLOCK_PROTOCOL_KEY,

    identifyDevice(req) {
      if (iclockRoute(req.path) === null) return null;
      const sn = serialOf(req);
      if (sn === null) return null;
      const pushver = queryValue(req.query, 'pushver');
      return { serialNumber: sn, extra: { route: iclockRoute(req.path), ...(pushver ? { pushver } : {}) } };
    },

    parseInbound(req, ctx: DevicePushParseContext): DevicePushInbound {
      const r = iclockRoute(req.path);
      if (r === null) throw new ProtocolError(`Unknown iclock route "${req.path}"`, { httpStatus: 404 });
      const sn = serialOf(req);
      if (sn === null) throw new ProtocolError('Missing or invalid SN query parameter');
      if (sn !== ctx.serialNumber) throw new ProtocolError('Serial number mismatch between request and context', { details: { expected: ctx.serialNumber } });
      assertBodySize(req.rawBody);
      const method = req.method.toUpperCase();

      if (r === 'cdata' && method === 'GET') {
        const extra: Record<string, unknown> = {};
        for (const k of ['options', 'pushver', 'language', 'DeviceType', 'PushOptionsFlag']) { const v = queryValue(req.query, k); if (v !== undefined) extra[k] = v; }
        return { kind: 'handshake', transactions: [], deviceInfo: { serialNumber: sn, extra }, response: text(renderHandshake(sn, ctx.stamps, opts)), meta: { route: r } };
      }
      if (r === 'cdata' && method === 'POST') {
        const table = (queryValue(req.query, 'table') ?? '').toUpperCase();
        if (table === '') throw new ProtocolError('POST /iclock/cdata requires a table parameter');
        // The stamp is persisted by the route and echoed on the next handshake: only well-formed values may be stored.
        const rawStamp = queryValue(req.query, 'Stamp') ?? queryValue(req.query, 'OpStamp');
        const stamp = rawStamp !== undefined && STAMP_PATTERN.test(rawStamp) ? rawStamp : undefined;
        if (table === 'ATTLOG') {
          const transactions = splitLines(req.rawBody).map((line, i) => parseAttlogLine(line, i, ctx.timezone, sn));
          return { kind: 'attendance', transactions, response: text(`OK: ${transactions.length}`), meta: { table, stamp: stamp ?? null, lines: transactions.length } };
        }
        if (table === 'OPERLOG') {
          const parsed = parseOperlogBody(req.rawBody);
          return { kind: 'user_data', transactions: [], employees: parsed.employees, response: text(`OK: ${parsed.lines}`), meta: { table, stamp: stamp ?? null, lines: parsed.lines, ignored: parsed.ignored } };
        }
        // ATTPHOTO, BIODATA, options, … — acknowledged so the device does not loop; nothing is stored.
        return { kind: 'unknown', transactions: [], response: text('OK'), meta: { table, stamp: stamp ?? null, ignored: true } };
      }
      if (r === 'getrequest' && method === 'GET') {
        const deviceInfo = parseInfoParam(queryValue(req.query, 'INFO'));
        return { kind: 'heartbeat', transactions: [], ...(deviceInfo ? { deviceInfo: { serialNumber: sn, ...deviceInfo } } : {}), response: text('OK'), meta: { route: r } };
      }
      if (r === 'devicecmd' && method === 'POST') {
        return { kind: 'command_result', transactions: [], commandResults: parseDeviceCmdBody(req.rawBody), response: text('OK'), meta: { route: r } };
      }
      if (r === 'registry' || r === 'push' || r === 'ping' || r === 'querydata') {
        return { kind: 'unknown', transactions: [], response: text('OK'), meta: { route: r, ignored: true } };
      }
      throw new ProtocolError(`${method} is not valid for /iclock/${r}`, { httpStatus: 405 });
    },

    renderCommands(commands) {
      if (commands.length === 0) return text('OK');
      return text(commands.map(renderCommandLine).join('\n') + '\n');
    },

    buildCommands(op) {
      switch (op.type) {
        case 'UPSERT_EMPLOYEE': return [{ commandType: 'UPSERT_EMPLOYEE', payload: userPayload(op.employee) }];
        case 'DELETE_EMPLOYEE': return [{ commandType: 'DELETE_EMPLOYEE', payload: { deviceUserId: pinPayload({ deviceUserId: op.deviceUserId }) } }];
        case 'RESTART': return [{ commandType: 'RESTART', payload: {} }];
        case 'QUERY_USERS': return [{ commandType: 'QUERY_USERS', payload: {} }];
      }
    },
  };
}
