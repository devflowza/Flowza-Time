import type { Trx } from './context.js';

export interface AuditEntry {
  organizationId: string | null;
  actorUserId: string | null;
  actorType?: 'USER' | 'SYSTEM' | 'PLATFORM_ADMIN' | 'API_KEY' | 'DEVICE';
  actorLabel?: string;
  action: string; // e.g. 'employee.created'
  entityType: string;
  entityId?: string | null;
  branchId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  jobId?: string | null;
}

/** Write an append-only audit row inside the caller's transaction. Never log secrets in old/new values. */
export async function writeAudit(trx: Trx, entry: AuditEntry): Promise<void> {
  await trx
    .insertInto('audit.logs')
    .values({
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      actorType: entry.actorType ?? (entry.actorUserId ? 'USER' : 'SYSTEM'),
      actorLabel: entry.actorLabel ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      branchId: entry.branchId ?? null,
      oldValue: entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
      newValue: entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
      reason: entry.reason ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      requestId: entry.requestId ?? null,
      jobId: entry.jobId ?? null,
    })
    .execute();
}

/** Keys removed from audit payloads. */
const SENSITIVE_KEYS = new Set(['password', 'pin', 'pinHash', 'pin_hash', 'apiKey', 'apiSecret', 'secret', 'token', 'commKey', 'ciphertext', 'credentials']);

export function redactForAudit<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactForAudit) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redactForAudit(v);
    }
    return out as T;
  }
  return value;
}
