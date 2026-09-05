import type { Database, DeviceCredentialsStore, JobQueue } from '@flowza/database';
import type { ProviderRegistry } from '@flowza/device-providers';
import type { Logger } from '@flowza/shared';
import type { WorkerConfig } from './config.js';

export interface RealtimePublisher { publish(channel: string, event: string, payload: Record<string, unknown>): Promise<void> }
export interface Mailer { send(msg: { to: string; subject: string; html: string; text?: string }): Promise<{ id: string | null; provider: string }> }
export interface StorageWriter {
  upload(bucket: string, path: string, body: Buffer, contentType: string): Promise<{ path: string; size: number }>;
  download(bucket: string, path: string): Promise<Buffer>;
  remove(bucket: string, paths: string[]): Promise<void>;
}

export interface WorkerDeps {
  config: WorkerConfig;
  log: Logger;
  db: Database;
  queue: JobQueue;
  credentials: DeviceCredentialsStore;
  providers: ProviderRegistry;
  realtime: RealtimePublisher;
  mailer: Mailer;
  storage: StorageWriter;
  now: () => Date;
}
