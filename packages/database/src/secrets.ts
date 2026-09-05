import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { MasterKey } from '@flowza/shared';
import { AppError } from '@flowza/shared';
import type { Trx } from './context.js';

/**
 * Envelope encryption for device credentials (ADR-003).
 * AES-256-GCM; the master key material never touches the database. `keyId` allows rotation:
 * new writes use keys[0]; reads accept any configured key.
 */
export interface EncryptedBlob { keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer }

/** Scope of an encrypted secret: the data key is derived per organisation (HKDF) and the AAD binds the device. */
export interface SecretScope { organizationId: string; deviceId: string }

export class SecretsCipher {
  private readonly byId: Map<string, Uint8Array>;
  private readonly primary: MasterKey;

  constructor(keys: MasterKey[]) {
    if (keys.length === 0) throw new Error('SecretsCipher requires at least one master key');
    this.primary = keys[0]!;
    this.byId = new Map(keys.map((k) => [k.id, k.material]));
  }

  /** Per-organisation data key: HKDF-SHA256(master, salt = organizationId, info = 'flowza-device-credentials'). */
  private dataKey(material: Uint8Array, organizationId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', material, Buffer.from(organizationId, 'utf8'), Buffer.from('flowza-device-credentials', 'utf8'), 32));
  }

  private aad(scope: SecretScope): Buffer { return Buffer.from(`${scope.organizationId}:${scope.deviceId}`, 'utf8'); }

  encrypt(plaintext: Record<string, unknown>, scope: SecretScope): EncryptedBlob {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.dataKey(this.primary.material, scope.organizationId), nonce);
    cipher.setAAD(this.aad(scope));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
    return { keyId: this.primary.id, nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  decrypt(blob: EncryptedBlob, scope: SecretScope): Record<string, unknown> {
    const key = this.byId.get(blob.keyId);
    if (!key) throw new AppError('INTERNAL_ERROR', `Unknown credentials key id ${blob.keyId}`);
    const decipher = createDecipheriv('aes-256-gcm', this.dataKey(key, scope.organizationId), blob.nonce);
    decipher.setAAD(this.aad(scope));
    decipher.setAuthTag(blob.authTag);
    const plain = Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Record<string, unknown>;
  }

  get primaryKeyId(): string { return this.primary.id; }
}

/** Mask a secret for display: keeps the last 4 characters when long enough. */
export function maskSecret(value: unknown): string {
  const s = String(value ?? '');
  if (s.length === 0) return '';
  if (s.length <= 4) return '****';
  return `****${s.slice(-4)}`;
}

export function maskCredentials(values: Record<string, unknown>, secretKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = secretKeys.includes(k) ? maskSecret(v) : v;
  return out;
}

/**
 * Store/retrieve device credentials through the secrets.* functions (system context required).
 * Additional authenticated data binds the ciphertext to the device id so blobs cannot be swapped between devices.
 */
export class DeviceCredentialsStore {
  constructor(private readonly cipher: SecretsCipher) {}

  async put(trx: Trx, scope: SecretScope, secrets: Record<string, unknown>, masked: Record<string, unknown>, updatedBy: string | null): Promise<number> {
    const { deviceId } = scope;
    const blob = this.cipher.encrypt(secrets, scope);
    const res = await sql<{ version: number }>`select secrets.put_device_credentials(
      ${deviceId}::uuid, ${blob.keyId}, ${blob.nonce}, ${blob.ciphertext}, ${blob.authTag}, ${JSON.stringify(masked)}::jsonb, ${updatedBy}::uuid
    ) as version`.execute(trx);
    return res.rows[0]?.version ?? 0;
  }

  async get(trx: Trx, scope: SecretScope): Promise<Record<string, unknown> | null> {
    const { deviceId } = scope;
    const res = await sql<{ keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer }>`select key_id, nonce, ciphertext, auth_tag from secrets.get_device_credentials(${deviceId}::uuid)`.execute(trx);
    const row = res.rows[0];
    if (!row) return null;
    return this.cipher.decrypt({ keyId: row.keyId, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.authTag }, scope);
  }

  async delete(trx: Trx, deviceId: string): Promise<boolean> {
    const res = await sql<{ ok: boolean }>`select secrets.delete_device_credentials(${deviceId}::uuid) as ok`.execute(trx);
    return res.rows[0]?.ok ?? false;
  }

  async masked(trx: Trx, deviceId: string): Promise<Record<string, unknown>> {
    const res = await sql<{ masked: Record<string, unknown> }>`select secrets.masked_device_credentials(${deviceId}::uuid) as masked`.execute(trx);
    return res.rows[0]?.masked ?? {};
  }
}
