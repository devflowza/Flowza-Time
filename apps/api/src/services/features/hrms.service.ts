import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import {
  API_KEY_SCOPES, API_KEYS_MAX_ACTIVE, DEFAULT_HRMS_SETTINGS, effectiveHrmsMapping, hrmsIntegrationSettingsSchema, resolveHrmsSettings,
  type ApiKeyCreatedDto, type ApiKeyDto, type ApiKeyScope, type HrmsBatchAcceptedDto, type HrmsBatchInput, type HrmsBatchListItem,
  type HrmsBatchStatusDto, type HrmsIntegrationDto, type HrmsIntegrationInput, type HrmsIntegrationSettings, type ImportKind,
} from '@flowza/contracts';
import { withContext, writeAudit, type Trx } from '@flowza/database';
import { AppError, errors, sha256Hex } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runSystem, runUser, withSystemScope } from '../../lib/service.js';
import { loadSettings } from '../../lib/settings.js';
import { isoDateTime, isoDateTimeOrNull, jsonArray, jsonObject } from '../../lib/mappers.js';
import { toCount } from '../../lib/pagination.js';
import { countAddedUsers, normaliseValues, queueImport, storeImport, validateEmployeeRows, validateOrgUnitRows, type ImportScope } from '../imports.service.js';
import { assertUserCapacity } from './user-limit.js';
import { mapHrmsRecord } from './hrms-mapping.js';

/*
 * HR system integration (docs/integrations/hrms.md): organisation API keys, the HRMS configuration (Settings → HR system) and
 * the inbound batch endpoints. The batches reuse the import pipeline: mapped → validated exactly like a file of the import
 * page (imports.service) → stored as an import job (source `hrms`) → EXECUTE_IMPORT in the worker, queued in the same
 * transaction. The organisation always comes from the API key, never from the request.
 */

// ---------------------------------------------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------------------------------------------

const PREFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** `fzk_<8 characters>_<43 characters>`: the public prefix identifies the key, the rest (256 bits) is the secret. */
const API_KEY_PATTERN = /^(fzk_[A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

function newApiKey(): { prefix: string; key: string } {
  const bytes = randomBytes(8);
  let body = '';
  for (const b of bytes) body += PREFIX_ALPHABET[b % PREFIX_ALPHABET.length];
  const prefix = `fzk_${body}`;
  return { prefix, key: `${prefix}_${randomBytes(32).toString('base64url')}` };
}

/** The public prefix of a presented key (for the per-key rate limiter); null when it is not shaped like a key. */
export function apiKeyPrefixOf(raw: string | undefined | null): string | null {
  const m = raw ? API_KEY_PATTERN.exec(raw.trim()) : null;
  return m ? m[1]! : null;
}

interface ApiKeyRow { id: string; name: string; keyPrefix: string; scopes: string[]; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; createdBy: string | null; createdByName: string | null; createdAt: Date }

function keyStatus(r: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()): ApiKeyDto['status'] {
  if (r.revokedAt) return 'revoked';
  if (r.expiresAt && r.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}
const asScopes = (v: string[]): ApiKeyScope[] => v.filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s));

function toApiKeyDto(r: ApiKeyRow): ApiKeyDto {
  return {
    id: r.id, name: r.name, prefix: r.keyPrefix, scopes: asScopes(r.scopes), status: keyStatus(r), lastUsedAt: isoDateTimeOrNull(r.lastUsedAt), expiresAt: isoDateTimeOrNull(r.expiresAt),
    revokedAt: isoDateTimeOrNull(r.revokedAt), createdBy: r.createdBy, createdByName: r.createdByName, createdAt: isoDateTime(r.createdAt),
  };
}

function keyQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('apiKeys as k').leftJoin('userProfiles as u', 'u.id', 'k.createdBy').where('k.organizationId', '=', orgId)
    .select(['k.id', 'k.name', 'k.keyPrefix', 'k.scopes', 'k.lastUsedAt', 'k.expiresAt', 'k.revokedAt', 'k.createdBy', 'u.fullName as createdByName', 'k.createdAt']);
}

export async function listApiKeys(deps: ApiDeps, actor: Actor, orgId: string): Promise<ApiKeyDto[]> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return runUser(deps.db, actor, async (trx) => (await keyQuery(trx, orgId).orderBy('k.createdAt', 'desc').limit(200).execute()).map((r) => toApiKeyDto(r as ApiKeyRow)));
}

/** Creates a key. The response is the ONLY place the full key ever appears: only its sha256 is stored, never logged or audited. */
export async function createApiKey(deps: ApiDeps, actor: Actor, orgId: string, input: { name: string; scopes: ApiKeyScope[]; expiresInDays: number }): Promise<ApiKeyCreatedDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return runUser(deps.db, actor, async (trx) => {
    const open = toCount((await trx.selectFrom('apiKeys').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('revokedAt', 'is', null).executeTakeFirst())?.n);
    if (open >= API_KEYS_MAX_ACTIVE) throw errors.conflict(`An organisation can hold at most ${API_KEYS_MAX_ACTIVE} API keys that are not revoked. Revoke the keys you no longer use first.`, { max: API_KEYS_MAX_ACTIVE });
    const { prefix, key } = newApiKey();
    const scopes = [...new Set(input.scopes)];
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
    const row = await trx.insertInto('apiKeys').values({ organizationId: orgId, name: input.name, keyPrefix: prefix, keyHash: sha256Hex(key), scopes, expiresAt, createdBy: actor.userId }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'integration.api_key_created', 'api_key', { entityId: row.id, newValue: { name: input.name, prefix, scopes, expiresAt: expiresAt.toISOString() } });
    const created = await keyQuery(trx, orgId).where('k.id', '=', row.id).executeTakeFirstOrThrow();
    return { ...toApiKeyDto(created as ApiKeyRow), secret: key };
  });
}

/** Revokes a key at once (idempotent: revoking a revoked key answers it unchanged). */
export async function revokeApiKey(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<ApiKeyDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await keyQuery(trx, orgId).where('k.id', '=', id).executeTakeFirst();
    if (!before) throw errors.notFound('API key', id);
    if (!before.revokedAt) {
      await trx.updateTable('apiKeys').set({ revokedAt: new Date(), revokedBy: actor.userId }).where('organizationId', '=', orgId).where('id', '=', id).where('revokedAt', 'is', null).execute();
      await audit(trx, actor, orgId, 'integration.api_key_revoked', 'api_key', { entityId: id, oldValue: { status: keyStatus(before) }, newValue: { status: 'revoked', name: before.name, prefix: before.keyPrefix } });
    }
    return toApiKeyDto((await keyQuery(trx, orgId).where('k.id', '=', id).executeTakeFirstOrThrow()) as ApiKeyRow);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Configuration (Settings → HR system)
// ---------------------------------------------------------------------------------------------------------------------------

function hrmsOf(settings: Awaited<ReturnType<typeof loadSettings>>): HrmsIntegrationSettings {
  return resolveHrmsSettings(settings.integrations.hrms ?? DEFAULT_HRMS_SETTINGS);
}
const endpointOf = (deps: ApiDeps) => `${deps.config.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/inbound/hrms`;

export async function getHrmsIntegration(deps: ApiDeps, actor: Actor, orgId: string): Promise<HrmsIntegrationDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return runUser(deps.db, actor, async (trx) => ({ ...hrmsOf(await loadSettings(trx, orgId)), endpoint: endpointOf(deps) }));
}

/**
 * Replaces `organization_settings.integrations.hrms` and leaves the other keys of the group alone. The configuration is
 * delegated to `integration.manage` (checked here, like the Finance connector); the settings row is written in the
 * organisation's system scope because the database's group guard grants the `integrations` group to organization.manage.
 */
export async function putHrmsIntegration(deps: ApiDeps, actor: Actor, orgId: string, input: HrmsIntegrationInput): Promise<HrmsIntegrationDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  const value = hrmsIntegrationSettingsSchema.parse(input);
  return runUser(deps.db, actor, async (trx) => {
    if (value.defaultBranchCode) {
      const branch = await withSystemScope(trx, orgId, (t) => t.selectFrom('branches').select(['id', 'status']).where('organizationId', '=', orgId).where(sql`lower(code::text)`, '=', value.defaultBranchCode!.toLowerCase()).executeTakeFirst());
      if (!branch || branch.status === 'archived') throw errors.validation('The default branch code does not name an active branch of the organisation.', { issues: [{ path: 'defaultBranchCode', message: 'Unknown branch' }] });
    }
    const before = hrmsOf(await loadSettings(trx, orgId));
    await withSystemScope(trx, orgId, async (t) => {
      const patch = JSON.stringify({ hrms: value });
      await t.insertInto('organizationSettings').values({ organizationId: orgId, integrations: patch, updatedBy: actor.userId } as never)
        .onConflict((oc) => oc.column('organizationId').doUpdateSet({ integrations: sql`coalesce(public.organization_settings.integrations, '{}'::jsonb) || ${patch}::jsonb`, updatedBy: actor.userId } as never))
        .execute();
    });
    await audit(trx, actor, orgId, 'integration.hrms_updated', 'organization_settings', { entityId: `${orgId}:integrations.hrms`, oldValue: before, newValue: value });
    return { ...hrmsOf(await loadSettings(trx, orgId)), endpoint: endpointOf(deps) };
  });
}

/** The latest HRMS batches for the Settings card (counts and status only — no row data). */
export async function listHrmsBatches(deps: ApiDeps, actor: Actor, orgId: string, limit = 20): Promise<HrmsBatchListItem[]> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return runUser(deps.db, actor, (trx) => withSystemScope(trx, orgId, async (t) => {
    const rows = await t.selectFrom('importJobs as i').leftJoin('apiKeys as k', 'k.id', 'i.apiKeyId')
      .select(['i.id', 'i.type', 'i.status', 'i.reference', 'k.keyPrefix', 'i.totalRows', 'i.validRows', 'i.errorRows', 'i.importedRows', 'i.createdAt'])
      .where('i.organizationId', '=', orgId).where('i.source', '=', 'hrms').orderBy('i.createdAt', 'desc').limit(Math.min(Math.max(limit, 1), 100)).execute();
    return rows.map((r) => ({ id: r.id, kind: r.type === 'ORG_UNITS' ? 'ORG_UNITS' as const : 'EMPLOYEES' as const, status: r.status, reference: r.reference, apiKeyPrefix: r.keyPrefix, totalRows: r.totalRows, validRows: r.validRows, errorRows: r.errorRows, importedRows: r.importedRows, createdAt: isoDateTime(r.createdAt) }));
  }));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Inbound (machine API, no user session)
// ---------------------------------------------------------------------------------------------------------------------------

export interface ApiKeyPrincipal { keyId: string; organizationId: string; prefix: string; scopes: ApiKeyScope[] }

const unauthenticated = (message: string) => new AppError('UNAUTHENTICATED', message);

/**
 * Resolves `Authorization: Bearer fzk_…`: the candidate rows are found by the public prefix in the platform context (the
 * organisation is not known yet; `app.api_key_candidates` returns that prefix's rows only), the sha256 of the presented key
 * is compared with timingSafeEqual, and a revoked or expired key is refused. `last_used_at` is stamped (at most once a minute)
 * in the organisation's system context.
 */
export async function authenticateApiKey(deps: ApiDeps, raw: string | undefined, requestId: string): Promise<ApiKeyPrincipal> {
  const presented = raw?.trim() ?? '';
  const prefix = apiKeyPrefixOf(presented);
  if (!prefix) throw unauthenticated('A valid API key is required (Authorization: Bearer fzk_…).');
  const candidates = await withContext(deps.db, { kind: 'platform', requestId }, async (trx) => (await sql<{ id: string; organizationId: string; keyHash: string; scopes: string[]; expiresAt: Date | null; revokedAt: Date | null }>`
    select id, organization_id as "organizationId", key_hash as "keyHash", scopes, expires_at as "expiresAt", revoked_at as "revokedAt" from app.api_key_candidates(${prefix})`.execute(trx)).rows);
  const hash = Buffer.from(sha256Hex(presented), 'hex');
  const key = candidates.find((c) => { const stored = Buffer.from(c.keyHash, 'hex'); return stored.length === hash.length && timingSafeEqual(stored, hash); });
  if (!key) throw unauthenticated('Invalid API key.');
  if (key.revokedAt) throw unauthenticated('This API key has been revoked.');
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) throw unauthenticated('This API key has expired.');
  await withContext(deps.db, { kind: 'system', organizationId: key.organizationId, requestId }, (trx) => trx.updateTable('apiKeys').set({ lastUsedAt: new Date() })
    .where('organizationId', '=', key.organizationId).where('id', '=', key.id)
    .where((eb) => eb.or([eb('lastUsedAt', 'is', null), eb('lastUsedAt', '<', sql<Date>`now() - interval '1 minute'`)])).execute());
  return { keyId: key.id, organizationId: key.organizationId, prefix, scopes: asScopes(key.scopes) };
}

function requireScope(key: ApiKeyPrincipal, ...accepted: ApiKeyScope[]): void {
  if (!accepted.some((s) => key.scopes.includes(s))) throw errors.forbidden(`This API key lacks the scope ${accepted.join(' or ')}.`);
}

/** The organisation may receive batches: not suspended / closed, and the feed switched on in Settings → HR system. */
async function assertFeedOpen(trx: Trx, orgId: string): Promise<HrmsIntegrationSettings> {
  const org = await trx.selectFrom('organizations').select('status').where('id', '=', orgId).executeTakeFirst();
  if (!org || org.status === 'suspended' || org.status === 'closed') throw errors.forbidden('The organisation is not active.');
  const hrms = hrmsOf(await loadSettings(trx, orgId));
  if (!hrms.enabled) throw new AppError('FEATURE_DISABLED', 'The HR system integration is switched off for this organisation (Settings → HR system).', { details: { feature: 'hrms' } });
  return hrms;
}

const SYSTEM_SCOPE: ImportScope = null;

function acceptedOf(row: { id: string; type: string; totalRows: number; validRows: number; errorRows: number; queueJobId: string | number | null }): HrmsBatchAcceptedDto {
  return { jobId: String(row.queueJobId ?? ''), status: 'QUEUED', batchId: row.id, kind: row.type === 'ORG_UNITS' ? 'ORG_UNITS' : 'EMPLOYEES', totalRows: row.totalRows, validRows: row.validRows, errorRows: row.errorRows };
}

export interface BatchOutcome { accepted: HrmsBatchAcceptedDto; replayed: boolean }

/**
 * POST /inbound/hrms/{employees|org-units}: maps the records with the organisation's mapping, validates them like an import
 * file (employees: upsert by employee number, statuses included; org units: upsert by code, parents in a second pass, loops
 * refused), stores the batch as an import job and queues EXECUTE_IMPORT in the same transaction → 202. A batch without one
 * valid record is stored (FAILED, for the audit trail and GET status) and answered 422 with the first errors. A repeated
 * Idempotency-Key with the same body answers the batch it created; with another body, 409.
 */
export async function submitHrmsBatch(deps: ApiDeps, key: ApiKeyPrincipal, kind: ImportKind, input: HrmsBatchInput, opts: { requestId: string; idempotencyKey?: string | null; requestHash: string }): Promise<BatchOutcome> {
  requireScope(key, 'hrms:write');
  const orgId = key.organizationId;
  const idempotencyKey = opts.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > 128) throw errors.validation('Idempotency-Key must be at most 128 characters.');
  let rejected: { batchId: string; errorRows: number; errors: HrmsBatchStatusDto['errors'] } | null = null;
  const outcome = await runSystem(deps.db, orgId, opts.requestId, async (trx): Promise<BatchOutcome | null> => {
    const hrms = await assertFeedOpen(trx, orgId);
    if (idempotencyKey) {
      // serialise retries of the same key, then answer the batch they already created
      await sql`select pg_advisory_xact_lock(hashtextextended(${`flowza:hrms-idem:${orgId}:${idempotencyKey}`}, 0))`.execute(trx);
      const prior = await trx.selectFrom('importJobs').select(['id', 'type', 'totalRows', 'validRows', 'errorRows', 'queueJobId', 'requestHash', 'status'])
        .where('organizationId', '=', orgId).where('idempotencyKey', '=', idempotencyKey).executeTakeFirst();
      if (prior) {
        if (prior.requestHash !== opts.requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different batch.');
        if (!prior.queueJobId) throw errors.unprocessable('This batch was already received and had no valid record.', { batchId: prior.id });
        return { accepted: acceptedOf(prior), replayed: true };
      }
    }
    const mapping = effectiveHrmsMapping(hrms);
    const ignored = new Set<string>();
    const objects = input.records.map((record) => {
      const mapped = mapHrmsRecord(kind, record, mapping);
      for (const f of mapped.ignored) ignored.add(f);
      return normaliseValues(mapped.object);
    });
    const rows = kind === 'ORG_UNITS'
      ? await validateOrgUnitRows(trx, orgId, objects, { scope: SYSTEM_SCOPE, firstRowNo: 1 })
      : await validateEmployeeRows(trx, orgId, objects, { updateExisting: true, scope: SYSTEM_SCOPE, canWriteSensitive: true, defaultBranchCode: hrms.defaultBranchCode, firstRowNo: 1 });
    const validRows = rows.filter((r) => r.errors.length === 0).length;
    const batchId = await storeImport(trx, orgId, {
      kind, source: 'hrms', fileName: input.reference ?? null, filePath: `hrms/${orgId}/${Date.now()}`, rows, requestedBy: null, apiKeyId: key.keyId,
      reference: input.reference ?? null, idempotencyKey, requestHash: opts.requestHash,
      options: { updateExisting: true, source: 'hrms', preset: hrms.preset },
      summary: { preset: hrms.preset, ignoredFields: [...ignored].slice(0, 50), receivedAt: new Date().toISOString() },
    });
    const auditBase = { organizationId: orgId, actorUserId: null, actorType: 'API_KEY' as const, actorLabel: key.prefix, entityType: 'import_job', entityId: batchId, requestId: opts.requestId };
    if (validRows === 0) {
      await trx.updateTable('importJobs').set({ status: 'FAILED', error: 'No valid record in the batch.' }).where('organizationId', '=', orgId).where('id', '=', batchId).execute();
      await writeAudit(trx, { ...auditBase, action: 'integration.hrms_batch_rejected', newValue: { kind, apiKeyId: key.keyId, totalRows: rows.length, errorRows: rows.length, reference: input.reference ?? null } });
      rejected = { batchId, errorRows: rows.length, errors: rows.flatMap((r) => r.errors.map((e) => ({ rowNo: r.rowNo, status: 'invalid', field: e.field, message: e.message }))).slice(0, 50) };
      return null;
    }
    // the user limit the platform set: every new active employee of the batch must fit, or nothing is stored (402)
    if (kind === 'EMPLOYEES') {
      const adding = await countAddedUsers(trx, orgId, batchId);
      if (adding > 0) await assertUserCapacity(trx, orgId, adding);
    }
    const jobId = await queueImport(deps, trx, orgId, batchId, { requestedBy: null, correlationId: opts.requestId });
    await writeAudit(trx, { ...auditBase, action: 'integration.hrms_batch_received', newValue: { kind, apiKeyId: key.keyId, totalRows: rows.length, validRows, errorRows: rows.length - validRows, jobId, reference: input.reference ?? null } });
    return { accepted: { jobId, status: 'QUEUED', batchId, kind, totalRows: rows.length, validRows, errorRows: rows.length - validRows }, replayed: false };
  });
  if (!outcome) {
    const r = rejected as { batchId: string; errorRows: number; errors: HrmsBatchStatusDto['errors'] } | null;
    throw errors.unprocessable('No record of the batch is valid: nothing was queued.', { batchId: r?.batchId, errorRows: r?.errorRows, errors: r?.errors ?? [] });
  }
  return outcome;
}

const MAX_STATUS_ERRORS = 200;

/** GET /inbound/hrms/batches/:id — a batch of the key's organisation (another organisation's id is simply not found). */
export async function getHrmsBatch(deps: ApiDeps, key: ApiKeyPrincipal, batchId: string, requestId: string): Promise<HrmsBatchStatusDto> {
  requireScope(key, 'hrms:read', 'hrms:write');
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw errors.notFound('Batch', batchId);
  const orgId = key.organizationId;
  return runSystem(deps.db, orgId, requestId, async (trx) => {
    const job = await trx.selectFrom('importJobs').select(['id', 'type', 'status', 'reference', 'totalRows', 'validRows', 'errorRows', 'importedRows', 'summary', 'createdAt', 'updatedAt'])
      .where('organizationId', '=', orgId).where('id', '=', batchId).where('source', '=', 'hrms').executeTakeFirst();
    if (!job) throw errors.notFound('Batch', batchId);
    const bad = await trx.selectFrom('importJobRows').select(['rowNo', 'status', 'errors']).where('organizationId', '=', orgId).where('importJobId', '=', batchId)
      // refused / failed rows, and imported rows whose second-pass link (manager, parent) could not be made
      .where((eb) => eb.or([eb('status', 'in', ['invalid', 'failed']), eb(sql`jsonb_array_length(errors)`, '>', 0)])).orderBy('rowNo').limit(MAX_STATUS_ERRORS).execute();
    const rowErrors = bad.flatMap((r) => {
      const list = jsonArray<{ field: string | null; message: string }>(r.errors);
      return (list.length ? list : [{ field: null, message: 'Failed' }]).map((e) => ({ rowNo: r.rowNo, status: r.status, field: e.field ?? null, message: String(e.message) }));
    }).slice(0, MAX_STATUS_ERRORS);
    return {
      batchId: job.id, kind: job.type === 'ORG_UNITS' ? 'ORG_UNITS' : 'EMPLOYEES', status: job.status, reference: job.reference, totalRows: job.totalRows, validRows: job.validRows, errorRows: job.errorRows,
      importedRows: job.importedRows, summary: job.summary ? jsonObject(job.summary) : null, errors: rowErrors, createdAt: isoDateTime(job.createdAt), updatedAt: isoDateTime(job.updatedAt),
    };
  });
}
