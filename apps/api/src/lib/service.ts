import type { Context } from 'hono';
import type { Principal } from '@flowza/domain';
import { withContext, writeAudit, redactForAudit, type Database, type Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import type { AppEnv } from '../middleware/request-context.js';
import { mapPgError } from '../middleware/error-handler.js';
import { clientIp } from './http.js';

/** Everything a service needs to know about the caller of the current request. */
export interface Actor {
  principal: Principal;
  userId: string;
  email: string;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export function actorOf(c: Context<AppEnv>, deps: ApiDeps): Actor {
  const principal = c.get('principal');
  if (!principal) throw errors.unauthenticated();
  return {
    principal,
    userId: principal.userId,
    email: principal.email,
    requestId: c.get('requestId'),
    ip: clientIp(c, deps.config.TRUST_PROXY),
    userAgent: c.req.header('user-agent')?.slice(0, 500) ?? null,
  };
}

/** Translate pg errors to AppErrors; everything else propagates unchanged. */
export function translatePgError(err: unknown): never {
  const mapped = mapPgError(err);
  if (mapped) throw mapped;
  throw err;
}

/** Run `fn` as the calling user (RLS applies as that user). Postgres errors are mapped to AppErrors. */
export async function runUser<T>(db: Database, actor: Actor, fn: (trx: Trx) => Promise<T>): Promise<T> {
  try {
    return await withContext(db, { kind: 'user', userId: actor.userId, email: actor.email || undefined, requestId: actor.requestId }, fn);
  } catch (err) {
    return translatePgError(err);
  }
}

/**
 * Run `fn` as the platform acting for exactly one organisation (RLS scoped to that org). Only used after an
 * explicit `requirePlatformAdmin` check or for flows where the caller is not (yet) a member (invitation acceptance).
 */
export async function runSystem<T>(db: Database, organizationId: string, requestId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  try {
    return await withContext(db, { kind: 'system', organizationId, requestId }, fn);
  } catch (err) {
    return translatePgError(err);
  }
}

/** Nil organisation id used as the system-context scope for platform-wide reference data (feature flags, plans). */
export const PLATFORM_SCOPE_ORG = '00000000-0000-0000-0000-000000000000';

export interface AuditOptions {
  entityId?: string | null;
  branchId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  actorType?: 'USER' | 'PLATFORM_ADMIN';
}

/** Audit row for the acting user (redacts secrets; carries request id, ip and user agent). */
export async function audit(trx: Trx, actor: Actor, organizationId: string | null, action: string, entityType: string, opts: AuditOptions = {}): Promise<void> {
  await writeAudit(trx, {
    organizationId,
    actorUserId: actor.userId,
    actorType: opts.actorType ?? 'USER',
    actorLabel: actor.email || undefined,
    action,
    entityType,
    entityId: opts.entityId ?? null,
    branchId: opts.branchId ?? null,
    oldValue: opts.oldValue === undefined ? undefined : redactForAudit(opts.oldValue),
    newValue: opts.newValue === undefined ? undefined : redactForAudit(opts.newValue),
    reason: opts.reason ?? null,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });
}

/** Returns only the keys of `next` whose value differs from `prev` (for compact audit diffs). */
export function diffObjects<T extends Record<string, unknown>>(prev: T, next: Partial<T>): { oldValue: Partial<T>; newValue: Partial<T> } {
  const oldValue: Partial<T> = {};
  const newValue: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      oldValue[key] = prev[key];
      newValue[key] = next[key] as T[keyof T];
    }
  }
  return { oldValue, newValue };
}
