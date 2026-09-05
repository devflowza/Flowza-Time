import { randomUUID, randomBytes, createHash } from 'node:crypto';

export const newId = (): string => randomUUID();
export const newRequestId = (): string => `req_${randomBytes(12).toString('base64url')}`;
export const newCorrelationId = (prefix = 'cor'): string => `${prefix}_${randomBytes(12).toString('base64url')}`;
export const sha256Hex = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
