import type { Database, JobQueue, DeviceCredentialsStore } from '@flowza/database';
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
}

/** Publishes progress/status events to Supabase Realtime broadcast channels (private, RLS-authorised). */
export interface RealtimePublisher {
  publish(channel: string, event: string, payload: Record<string, unknown>): Promise<void>;
}
/** Creates short-lived signed URLs for tenant-scoped storage objects. */
export interface StorageSigner {
  signedUrl(bucket: string, path: string, expiresInSeconds?: number): Promise<string | null>;
}
