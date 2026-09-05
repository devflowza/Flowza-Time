import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PUNCH_DIRECTIONS, VERIFICATION_METHODS, type RawTransaction } from '@flowza/contracts';
import { sha256Hex } from '@flowza/shared';
import type { WebhookHandlingResult, WebhookRequest } from '../../types.js';
import { headerValue } from '../../protocol-utils.js';

/**
 * Simulated vendor webhook. Two signature transports are accepted:
 *  - header `x-mock-signature: sha256hex(secret + rawBody)` (preferred; mirrors real vendors), or
 *  - body field `signature = sha256hex(secret + canonicalMockPayload(bodyWithoutSignature))` (self-contained JSON).
 * Both use `secrets.webhookSecret`.
 */
export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

const webhookTransactionSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  deviceUserId: z.string().min(1).max(64),
  punchedAt: z.iso.datetime({ offset: true }),
  method: z.enum(VERIFICATION_METHODS).optional(),
  direction: z.enum(PUNCH_DIRECTIONS).optional(),
});
export const mockWebhookPayloadSchema = z.object({
  eventId: z.string().min(1).max(200),
  deviceSerial: z.string().min(1).max(120),
  transactions: z.array(webhookTransactionSchema).max(5000),
});
export type MockWebhookPayload = z.infer<typeof mockWebhookPayloadSchema>;
const mockWebhookBodySchema = mockWebhookPayloadSchema.extend({ signature: z.string().min(1).max(200).optional() });

/** Stable serialisation used for the inline (body) signature. */
export function canonicalMockPayload(payload: MockWebhookPayload): string {
  return JSON.stringify({
    eventId: payload.eventId,
    deviceSerial: payload.deviceSerial,
    transactions: payload.transactions.map((t) => ({ id: t.id, deviceUserId: t.deviceUserId, punchedAt: t.punchedAt, method: t.method, direction: t.direction })),
  });
}

export const mockWebhookSignature = (secret: string, signedText: string): string => sha256Hex(secret + signedText);

/** Builds a header-signed request body for tests/simulators. */
export function signMockWebhook(secret: string, payload: MockWebhookPayload): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(payload);
  return { rawBody, headers: { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: mockWebhookSignature(secret, rawBody) } };
}

/** Builds a body-signed request for tests/simulators. */
export function signMockWebhookInline(secret: string, payload: MockWebhookPayload): { rawBody: string; headers: Record<string, string> } {
  const body = { ...payload, signature: mockWebhookSignature(secret, canonicalMockPayload(payload)) };
  return { rawBody: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'));
}

function reject(status: number, error: string, signatureValid: boolean | null, eventId: string | null = null): WebhookHandlingResult {
  return { accepted: false, eventId, transactions: [], response: { status, body: { error } }, signatureValid };
}

export function handleMockWebhook(req: WebhookRequest, secrets: Record<string, unknown>): WebhookHandlingResult {
  const secret = secrets.webhookSecret;
  if (typeof secret !== 'string' || secret.length === 0) return reject(401, 'webhook_secret_not_configured', null);

  let json: unknown;
  try { json = JSON.parse(req.rawBody); } catch { return reject(400, 'invalid_json', null); }
  const parsed = mockWebhookBodySchema.safeParse(json);
  if (!parsed.success) return reject(400, 'invalid_payload', null);
  const { signature, ...payload } = parsed.data;

  const headerSig = headerValue(req.headers, MOCK_SIGNATURE_HEADER);
  let signatureValid: boolean;
  if (headerSig !== undefined) signatureValid = safeEqualHex(headerSig, mockWebhookSignature(secret, req.rawBody));
  else if (signature !== undefined) signatureValid = safeEqualHex(signature, mockWebhookSignature(secret, canonicalMockPayload(payload)));
  else return reject(401, 'missing_signature', false, payload.eventId);
  if (!signatureValid) return reject(401, 'invalid_signature', false, payload.eventId);

  const transactions: RawTransaction[] = payload.transactions.map((t, i) => ({
    providerTransactionId: t.id ?? `${payload.eventId}:${i}`,
    deviceEmployeeId: t.deviceUserId,
    punchedAt: t.punchedAt,
    deviceLocalTime: null,
    verificationMethod: t.method ?? 'unknown',
    direction: t.direction ?? 'unknown',
    rawPayload: { eventId: payload.eventId, deviceSerial: payload.deviceSerial, index: i, simulated: true },
  }));
  return {
    accepted: true,
    eventId: payload.eventId,
    eventType: 'attendance',
    vendorDeviceId: payload.deviceSerial,
    transactions,
    response: { status: 200, body: { received: transactions.length } },
    signatureValid: true,
  };
}
