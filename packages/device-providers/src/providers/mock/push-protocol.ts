import { PUNCH_DIRECTIONS, VERIFICATION_METHODS, type PunchDirection, type RawTransaction, type VerificationMethod } from '@flowza/contracts';
import { ProtocolError } from '../../errors.js';
import { assertBodySize, parseDeviceTime, splitLines, toIsoUtc } from '../../protocol-utils.js';
import type { DevicePushCommand, DevicePushInbound, DevicePushProtocolHandler, DevicePushRequest, DevicePushResponse } from '../../types.js';

/**
 * Tiny line protocol so the DEVICE_PUSH mode can be exercised end to end without hardware:
 *  - POST /device-push/mock/:serial/attendance      body lines `deviceUserId,isoTime[,method[,direction[,id]]]` → `OK: <n>`
 *  - GET  /device-push/mock/:serial/commands        → pending commands as a JSON array (or `[]`)
 *  - GET  /device-push/mock/:serial/handshake       optional JSON body `{ model, firmwareVersion }` → `OK`
 *  - POST /device-push/mock/:serial/command-results body lines `commandId,ok[,message]` → `OK`
 * Times without an offset are interpreted in the device timezone.
 */
export const MOCK_PROTOCOL_KEY = 'mock';
type MockRoute = 'attendance' | 'commands' | 'handshake' | 'command-results';
const ROUTE = /(?:^|\/)mock\/([A-Za-z0-9_-]{1,64})\/(attendance|commands|handshake|command-results)\/?$/;

function route(req: DevicePushRequest): { serialNumber: string; route: MockRoute } | null {
  const m = ROUTE.exec(req.path.split('?')[0] ?? '');
  if (!m) return null;
  return { serialNumber: m[1] ?? '', route: m[2] as MockRoute };
}
const text = (body: string, status = 200): DevicePushResponse => ({ status, body, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const json = (value: unknown, status = 200): DevicePushResponse => ({ status, body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });

const isMethod = (v: string): v is VerificationMethod => (VERIFICATION_METHODS as readonly string[]).includes(v);
const isDirection = (v: string): v is PunchDirection => (PUNCH_DIRECTIONS as readonly string[]).includes(v);
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function parseMockAttendanceLine(line: string, index: number, timezone: string, serialNumber: string): RawTransaction {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 5) throw new ProtocolError(`Attendance line ${index + 1}: expected 2–5 comma-separated fields, got ${parts.length}`, { details: { line: index + 1 } });
  const [deviceUserId = '', time = '', method = 'unknown', direction = 'unknown', id] = parts;
  if (!ID_PATTERN.test(deviceUserId)) throw new ProtocolError(`Attendance line ${index + 1}: invalid device user id`, { details: { line: index + 1 } });
  if (!isMethod(method)) throw new ProtocolError(`Attendance line ${index + 1}: unknown verification method "${method}"`, { details: { line: index + 1 } });
  if (!isDirection(direction)) throw new ProtocolError(`Attendance line ${index + 1}: unknown direction "${direction}"`, { details: { line: index + 1 } });
  if (id !== undefined && id !== '' && !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new ProtocolError(`Attendance line ${index + 1}: invalid transaction id`, { details: { line: index + 1 } });
  const at = parseDeviceTime(time, timezone);
  return {
    providerTransactionId: id !== undefined && id !== '' ? id : null,
    deviceEmployeeId: deviceUserId,
    punchedAt: toIsoUtc(at),
    deviceLocalTime: time,
    verificationMethod: method,
    direction,
    rawPayload: { protocol: MOCK_PROTOCOL_KEY, serialNumber, line: index + 1, simulated: true },
  };
}

export function createMockPushProtocol(): DevicePushProtocolHandler {
  return {
    protocolKey: MOCK_PROTOCOL_KEY,
    identifyDevice(req) {
      const r = route(req);
      return r ? { serialNumber: r.serialNumber, extra: { route: r.route } } : null;
    },
    parseInbound(req, ctx): DevicePushInbound {
      const r = route(req);
      if (!r) throw new ProtocolError(`Unknown mock push route "${req.path}"`, { httpStatus: 404 });
      if (r.serialNumber !== ctx.serialNumber) throw new ProtocolError('Serial number mismatch between route and context');
      assertBodySize(req.rawBody);
      const method = req.method.toUpperCase();
      switch (r.route) {
        case 'attendance': {
          if (method !== 'POST') throw new ProtocolError('attendance requires POST', { httpStatus: 405 });
          const transactions = splitLines(req.rawBody).map((line, i) => parseMockAttendanceLine(line, i, ctx.timezone, ctx.serialNumber));
          return { kind: 'attendance', transactions, response: text(`OK: ${transactions.length}`), meta: { lines: transactions.length } };
        }
        case 'commands':
          if (method !== 'GET') throw new ProtocolError('commands requires GET', { httpStatus: 405 });
          return { kind: 'heartbeat', transactions: [], response: json([]) };
        case 'handshake': {
          let deviceInfo: DevicePushInbound['deviceInfo'] = { serialNumber: ctx.serialNumber };
          if (req.rawBody.trim().length > 0) {
            let body: unknown;
            try { body = JSON.parse(req.rawBody); } catch { throw new ProtocolError('handshake body must be JSON'); }
            if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ProtocolError('handshake body must be a JSON object');
            const b = body as Record<string, unknown>;
            deviceInfo = {
              serialNumber: ctx.serialNumber,
              ...(typeof b.model === 'string' ? { model: b.model } : {}),
              ...(typeof b.firmwareVersion === 'string' ? { firmwareVersion: b.firmwareVersion } : {}),
            };
          }
          return { kind: 'handshake', transactions: [], deviceInfo, response: text('OK') };
        }
        case 'command-results': {
          if (method !== 'POST') throw new ProtocolError('command-results requires POST', { httpStatus: 405 });
          const commandResults = splitLines(req.rawBody).map((line, i) => {
            const [commandId = '', ok = '', ...rest] = line.split(',').map((p) => p.trim());
            if (!ID_PATTERN.test(commandId)) throw new ProtocolError(`Command result line ${i + 1}: invalid command id`);
            if (ok !== 'ok' && ok !== 'error') throw new ProtocolError(`Command result line ${i + 1}: status must be "ok" or "error"`);
            const message = rest.join(',');
            return { commandId, ok: ok === 'ok', ...(message ? { message } : {}) };
          });
          return { kind: 'command_result', transactions: [], commandResults, response: text('OK') };
        }
        default:
          throw new ProtocolError('Unhandled mock route');
      }
    },
    renderCommands(commands: DevicePushCommand[]) {
      return json(commands.map((c) => ({ id: c.id, commandType: c.commandType, payload: c.payload })));
    },
    buildCommands(op) {
      switch (op.type) {
        case 'UPSERT_EMPLOYEE': return [{ commandType: 'UPSERT_EMPLOYEE', payload: { employee: op.employee } }];
        case 'DELETE_EMPLOYEE': return [{ commandType: 'DELETE_EMPLOYEE', payload: { deviceUserId: op.deviceUserId } }];
        case 'RESTART': return [{ commandType: 'RESTART', payload: {} }];
        case 'QUERY_USERS': return [{ commandType: 'QUERY_USERS', payload: {} }];
      }
    },
  };
}
