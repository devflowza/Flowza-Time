import type { Database, JobQueue, DeviceCredentialsStore, Trx } from '@flowza/database';
import type { ProviderRegistry } from '@flowza/device-providers';
import type { Logger } from '@flowza/shared';
import type { ApiConfig } from './config.js';
import type { VerifiedToken } from './lib/jwt.js';

/** Dependency container handed to every route module (constructor injection keeps services testable). */
export interface ApiDeps {
  config: ApiConfig;
  log: Logger;
  db: Database;
  queue: JobQueue;
  credentials: DeviceCredentialsStore;
  providers: ProviderRegistry;
  verifyToken: (token: string) => Promise<VerifiedToken>;
  realtime: RealtimePublisher;
  storage: StorageSigner;
  /**
   * Ends a user's Supabase Auth sessions when their access is taken away (member suspension, role downgrade, an
   * employee who leaves). Optional so test harnesses need not build one: when absent the database-backed revoker of
   * lib/sessions.ts is used — tests inject a spy here.
   */
  sessions?: SessionRevoker;
}

/** Why sessions are being ended (logged and audited next to the membership change). */
export type SessionRevocationReason = 'member_suspended' | 'role_downgraded' | 'employee_left';

export interface SessionRevocation {
  organizationId: string;
  userIds: string[];
  reason: SessionRevocationReason;
  requestId: string;
}

/**
 * `revoked` = sessions ended; `available: false` when the auth schema could not be reached (the local shim has no
 * auth.sessions): the membership change still closed the organisation, because every request re-reads memberships.
 */
export interface SessionRevocationResult { revoked: number; available: boolean }

/**
 * Runs inside the caller's transaction (so a rolled-back suspension never ends anybody's session) — the implementation
 * switches to the organisation's system scope itself.
 */
export interface SessionRevoker {
  revokeUserSessions(trx: Trx, input: SessionRevocation): Promise<SessionRevocationResult>;
}

/** Publishes progress/status events to Supabase Realtime broadcast channels (private, RLS-authorised). */
export interface RealtimePublisher {
  publish(channel: string, event: string, payload: Record<string, unknown>): Promise<void>;
}
/** Creates short-lived signed URLs for tenant-scoped storage objects. */
export interface StorageSigner {
  signedUrl(bucket: string, path: string, expiresInSeconds?: number): Promise<string | null>;
}
