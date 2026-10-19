/**
 * HR system (HRMS) integration — Mawred Plus workstream: organisation API keys (secret shown once, hash only, revoke, expiry,
 * tenant-bound), the HRMS configuration (integration.manage, stored in the integrations settings group without touching the
 * rest of it), the inbound batch API (key auth, scope, feed switch, mapping, validation, enqueue in the same transaction,
 * idempotency, batch status, rate limit) and the import page's org-unit and .xlsx imports.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@flowza/shared';
import { HRMS_INBOUND_LIMITS } from '../app.js';
import { createTestApi, F, type TestApi } from './harness.js';

let api: TestApi;
beforeAll(async () => { api = await createTestApi('hrms'); }, 180_000);
afterAll(async () => { await api?.close(); });

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

/** POST/GET on the inbound API with an API key (no user session). */
async function inbound(method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers['authorization'] = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return api.request(method, `/inbound/hrms${path}`, { headers, ...(opts.body !== undefined ? { raw: JSON.stringify(opts.body) } : {}) });
}

async function createKey(user: string, orgId: string, body: Record<string, unknown> = { name: 'Mawred Plus feed', scopes: ['hrms:write'] }) {
  return api.request('POST', `/orgs/${orgId}/api-keys`, { user, body });
}

async function enableFeed(orgId: string, user: string, extra: Record<string, unknown> = {}) {
  const res = await api.request('PUT', `/orgs/${orgId}/integrations/hrms`, { user, body: { enabled: true, preset: 'mawred_plus', ...extra } });
  expect(res.status).toBe(200);
  return res;
}

describe('API keys', () => {
  it('shows the secret once, stores only its sha256, lists without it, revokes, and is audited without the secret', async () => {
    const denied = await createKey(F.hrUserA, F.orgA);
    expect(denied.status).toBe(403);
    const invalid = await createKey(F.ownerA, F.orgA, { name: 'x', scopes: ['admin:all'] });
    expect(invalid.status).toBe(400);
    const res = await createKey(F.ownerA, F.orgA, { name: 'Mawred Plus feed', scopes: ['hrms:write', 'hrms:read'], expiresInDays: 30 });
    expect(res.status).toBe(201);
    const key = res.json.data;
    expect(key.secret).toMatch(/^fzk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(key.secret.startsWith(`${key.prefix}_`)).toBe(true);
    expect(key).toMatchObject({ name: 'Mawred Plus feed', status: 'active', scopes: ['hrms:write', 'hrms:read'], createdBy: F.ownerA, lastUsedAt: null });
    expect(Date.parse(key.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const row = await api.tdb.adminDb.selectFrom('apiKeys').selectAll().where('id', '=', key.id).executeTakeFirstOrThrow();
    expect(row.keyHash).toBe(sha256Hex(key.secret));
    expect(JSON.stringify(row)).not.toContain(key.secret.slice(14));
    const list = await api.request('GET', `/orgs/${F.orgA}/api-keys`, { user: F.ownerA });
    expect(list.status).toBe(200);
    expect(list.json.data.map((k: { id: string }) => k.id)).toContain(key.id);
    expect(list.text).not.toContain(key.secret);
    expect(list.text).not.toContain(row.keyHash);
    // another organisation's member never reaches this organisation's keys
    expect((await api.request('GET', `/orgs/${F.orgA}/api-keys`, { user: F.ownerB })).status).toBe(403);
    expect((await api.request('POST', `/orgs/${F.orgB}/api-keys/${key.id}/revoke`, { user: F.ownerB })).status).toBe(404);
    const revoked = await api.request('POST', `/orgs/${F.orgA}/api-keys/${key.id}/revoke`, { user: F.ownerA });
    expect(revoked.json.data).toMatchObject({ id: key.id, status: 'revoked' });
    expect((await api.request('POST', `/orgs/${F.orgA}/api-keys/${key.id}/revoke`, { user: F.ownerA })).json.data.status).toBe('revoked');
    const audits = await api.tdb.adminDb.selectFrom('audit.logs').select(['action', 'newValue']).where('entityId', '=', key.id).orderBy('id').execute();
    expect(audits.map((a) => a.action)).toEqual(['integration.api_key_created', 'integration.api_key_revoked']);
    expect(JSON.stringify(audits)).not.toContain(key.secret);
    // a revoked key opens nothing
    const refused = await inbound('GET', `/batches/${key.id}`, { key: key.secret });
    expect(refused.status).toBe(401);
    expect(refused.json.message).toMatch(/revoked/);
  });

  it('refuses a missing, malformed, unknown or expired key (401, WWW-Authenticate)', async () => {
    const none = await inbound('POST', '/employees', { body: { records: [{ a: 1 }] } });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    expect(none.json.code).toBe('UNAUTHENTICATED');
    // a user session is not an API key
    expect((await api.request('POST', '/inbound/hrms/employees', { user: F.ownerA, body: { records: [{ a: 1 }] } })).status).toBe(401);
    expect((await inbound('POST', '/employees', { key: 'fzk_AAAAAAAA_short', body: { records: [{ a: 1 }] } })).status).toBe(401);
    const res = await createKey(F.ownerA, F.orgA, { name: 'to expire', scopes: ['hrms:write'], expiresInDays: 1 });
    const secret: string = res.json.data.secret;
    const tampered = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    expect((await inbound('POST', '/employees', { key: tampered, body: { records: [{ a: 1 }] } })).json.message).toBe('Invalid API key.');
    await api.tdb.adminDb.updateTable('apiKeys').set({ expiresAt: new Date(Date.now() - 1000) }).where('id', '=', res.json.data.id).execute();
    const expired = await inbound('POST', '/employees', { key: secret, body: { records: [{ a: 1 }] } });
    expect(expired.status).toBe(401);
    expect(expired.json.message).toMatch(/expired/);
    expect((await api.request('GET', `/orgs/${F.orgA}/api-keys`, { user: F.ownerA })).json.data.find((k: { id: string }) => k.id === res.json.data.id).status).toBe('expired');
  });
});

describe('HRMS configuration', () => {
  it('needs integration.manage, refuses {} (a PUT is the whole configuration), and keeps the rest of the integrations group', async () => {
    expect((await api.request('GET', `/orgs/${F.orgA}/integrations/hrms`, { user: F.hrUserA })).status).toBe(403);
    const initial = await api.request('GET', `/orgs/${F.orgA}/integrations/hrms`, { user: F.ownerA });
    expect(initial.json.data).toMatchObject({ enabled: false, preset: 'generic', employeeMapping: [], defaultBranchCode: null });
    expect(initial.json.data.endpoint).toMatch(/\/api\/v1\/inbound\/hrms$/);
    expect((await api.request('PUT', `/orgs/${F.orgA}/integrations/hrms`, { user: F.ownerA, body: {} })).status).toBe(400);
    expect((await api.request('PUT', `/orgs/${F.orgA}/integrations/hrms`, { user: F.ownerA, body: { enabled: true, preset: 'generic', defaultBranchCode: 'NOPE' } })).status).toBe(400);
    expect((await api.request('PUT', `/orgs/${F.orgA}/integrations/hrms`, { user: F.ownerA, body: { enabled: true, preset: 'generic', employeeMapping: [{ source: 'Staff_No', target: 'not_a_field' }] } })).status).toBe(400);
    expect((await api.request('PUT', `/orgs/${F.orgA}/integrations/hrms`, { user: F.ownerA, body: { enabled: true, preset: 'generic', employeeMapping: [{ source: 'A', target: 'firstName' }, { source: 'a', target: 'lastName' }] } })).status).toBe(400);
    // another key of the group survives the HRMS save
    await api.tdb.adminDb.updateTable('organizationSettings').set({ integrations: JSON.stringify({ other: { keep: true } }) }).where('organizationId', '=', F.orgA).execute();
    const mapping = { Staff_No: 'employeeNumber', Name_En: 'firstName', Surname: 'lastName', Hired: 'joiningDate', Unit: 'departmentCode', Status: 'employmentStatus', civil_id: 'civilId', Location: 'branchCode' };
    const saved = await enableFeed(F.orgA, F.ownerA, { employeeMapping: Object.entries(mapping).map(([source, target]) => ({ source, target })), defaultBranchCode: 'a-hq' });
    expect(saved.json.data).toMatchObject({ enabled: true, preset: 'mawred_plus', defaultBranchCode: 'a-hq' });
    // HR-system names keep their spelling (underscores included) through the database
    expect((await api.request('GET', `/orgs/${F.orgA}/integrations/hrms`, { user: F.ownerA })).json.data.employeeMapping).toContainEqual({ source: 'Staff_No', target: 'employeeNumber' });
    const stored = await api.tdb.adminDb.selectFrom('organizationSettings').select('integrations').where('organizationId', '=', F.orgA).executeTakeFirstOrThrow();
    expect(stored.integrations).toMatchObject({ other: { keep: true }, hrms: { enabled: true, preset: 'mawred_plus' } });
    const audit = await api.tdb.adminDb.selectFrom('audit.logs').select('action').where('organizationId', '=', F.orgA).where('action', '=', 'integration.hrms_updated').execute();
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe('inbound HRMS batches', () => {
  let writeKey: string;
  let batchId: string;

  beforeAll(async () => {
    writeKey = (await createKey(F.ownerA, F.orgA, { name: 'feed', scopes: ['hrms:write'] })).json.data.secret;
  });

  it('refuses a batch while the feed is switched off (403), and a read-only key', async () => {
    const keyB = (await createKey(F.ownerB, F.orgB)).json.data.secret as string;
    const off = await inbound('POST', '/employees', { key: keyB, body: { records: [{ employeeNumber: 'X-1' }] } });
    expect(off.status).toBe(403);
    expect(off.json.code).toBe('FEATURE_DISABLED');
    const readOnly = (await createKey(F.ownerA, F.orgA, { name: 'reader', scopes: ['hrms:read'] })).json.data.secret as string;
    expect((await inbound('POST', '/employees', { key: readOnly, body: { records: [{ employeeNumber: 'X-1' }] } })).status).toBe(403);
  });

  it('maps the records, validates them like an import file and queues EXECUTE_IMPORT for the key\'s organisation (202)', async () => {
    const bad = await inbound('POST', '/employees', { key: writeKey, body: { records: [] } });
    expect(bad.status).toBe(400);
    const tooMany = await inbound('POST', '/employees', { key: writeKey, body: { records: Array.from({ length: 501 }, (_, i) => ({ Staff_No: `S-${i}` })) } });
    expect(tooMany.status).toBe(400);
    const res = await inbound('POST', '/employees', {
      key: writeKey,
      headers: { 'idempotency-key': 'batch-1' },
      body: {
        reference: 'MAWRED-2026-10-19-01',
        records: [
          // new employee, Mawred-style field names (the organisation's mapping), Arabic status label of the preset, DD/MM/YYYY date
          { Staff_No: 'M-100', Name_En: 'Fatma', Surname: 'Al Balushi', FullNameAr: 'فاطمة البلوشية', Hired: '01/10/2026', Unit: 'OPS', Status: 'على رأس العمل', civil_id: '87654321', organizationId: F.orgB },
          // existing employee: only the status changes (the preset's English label)
          { Staff_No: 'E-002', Status: 'Resigned' },
          // unknown department → refused row
          { Staff_No: 'M-101', Name_En: 'Ahmed', Surname: 'X', Hired: '2026-10-01', Unit: 'NOPE' },
        ],
      },
    });
    expect(res.status).toBe(202);
    expect(res.json.data).toMatchObject({ status: 'QUEUED', kind: 'EMPLOYEES', totalRows: 3, validRows: 2, errorRows: 1 });
    batchId = res.json.data.batchId;
    const job = await api.tdb.adminDb.selectFrom('jobs.queue').select(['id', 'organizationId', 'payload', 'queueName']).where('jobType', '=', 'EXECUTE_IMPORT').where('id', '=', res.json.data.jobId).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ organizationId: F.orgA, queueName: 'processing', payload: { organizationId: F.orgA, importJobId: batchId, requestedBy: null } });
    const stored = await api.tdb.adminDb.selectFrom('importJobs').selectAll().where('id', '=', batchId).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ organizationId: F.orgA, source: 'hrms', type: 'EMPLOYEES', status: 'IMPORTING', reference: 'MAWRED-2026-10-19-01', idempotencyKey: 'batch-1' });
    expect((stored.summary as { ignoredFields: string[] }).ignoredFields).toEqual(['FullNameAr', 'organizationId']);
    const rows = await api.tdb.adminDb.selectFrom('importJobRows').select(['rowNo', 'status', 'data', 'errors']).where('importJobId', '=', batchId).orderBy('rowNo').execute();
    expect(rows[0]).toMatchObject({ rowNo: 1, status: 'valid', data: { employeeNumber: 'M-100', firstName: 'Fatma', joiningDate: '2026-10-01', employmentStatus: 'active', branchId: F.branchHQ, departmentId: F.deptOps, civilId: '87654321' } });
    expect(rows[1]).toMatchObject({ rowNo: 2, status: 'valid', data: { existingEmployeeId: F.empE2, employmentStatus: 'resigned' } });
    expect(rows[2]).toMatchObject({ rowNo: 3, status: 'invalid' });
    const audit = await api.tdb.adminDb.selectFrom('audit.logs').select(['action', 'actorType', 'actorUserId']).where('entityId', '=', batchId).executeTakeFirstOrThrow();
    expect(audit).toEqual({ action: 'integration.hrms_batch_received', actorType: 'API_KEY', actorUserId: null });
    // the key's last use is recorded
    const keys = await api.request('GET', `/orgs/${F.orgA}/api-keys`, { user: F.ownerA });
    expect(keys.json.data.find((k: { prefix: string }) => writeKey.startsWith(k.prefix)).lastUsedAt).not.toBeNull();
  });

  it('replays an Idempotency-Key with the same body, refuses it with another (409)', async () => {
    const body = { records: [{ Staff_No: 'E-002', Status: 'Resigned' }] };
    const first = await inbound('POST', '/employees', { key: writeKey, headers: { 'idempotency-key': 'batch-2' }, body });
    expect(first.status).toBe(202);
    const replay = await inbound('POST', '/employees', { key: writeKey, headers: { 'idempotency-key': 'batch-2' }, body });
    expect(replay.status).toBe(202);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(replay.json.data).toEqual(first.json.data);
    const conflict = await inbound('POST', '/employees', { key: writeKey, headers: { 'idempotency-key': 'batch-2' }, body: { records: [{ Staff_No: 'E-001', Status: 'Resigned' }] } });
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await api.tdb.adminDb.selectFrom('importJobs').select('id').where('idempotencyKey', '=', 'batch-2').execute()).toHaveLength(1);
  });

  it('answers 422 with the errors (and keeps the batch) when no record is valid', async () => {
    const res = await inbound('POST', '/employees', { key: writeKey, body: { records: [{ Staff_No: 'Z-1', Name_En: 'No', Surname: 'Branch', Hired: '2026-10-01', Location: 'NOPE' }] } });
    expect(res.status).toBe(422);
    expect(res.json.details.errors[0]).toMatchObject({ rowNo: 1, field: 'branchCode' });
    const batch = await api.tdb.adminDb.selectFrom('importJobs').select(['status', 'queueJobId']).where('id', '=', res.json.details.batchId).executeTakeFirstOrThrow();
    expect(batch).toEqual({ status: 'FAILED', queueJobId: null });
  });

  it('reports a batch\'s status to its organisation only', async () => {
    const res = await inbound('GET', `/batches/${batchId}`, { key: writeKey });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ batchId, kind: 'EMPLOYEES', status: 'IMPORTING', reference: 'MAWRED-2026-10-19-01', totalRows: 3, validRows: 2, errorRows: 1 });
    expect(res.json.data.errors).toEqual([{ rowNo: 3, status: 'invalid', field: 'departmentCode', message: 'Unknown department code "NOPE"' }]);
    const keyB = (await createKey(F.ownerB, F.orgB, { name: 'b reader', scopes: ['hrms:read'] })).json.data.secret as string;
    expect((await inbound('GET', `/batches/${batchId}`, { key: keyB })).status).toBe(404);
    // the Settings card lists the batch (counts only)
    const list = await api.request('GET', `/orgs/${F.orgA}/integrations/hrms/batches`, { user: F.ownerA });
    expect(list.json.data[0]).toMatchObject({ kind: 'EMPLOYEES', apiKeyPrefix: writeKey.slice(0, 12) });
  });

  it('upserts org units: parents by code (file or organisation), loops refused', async () => {
    const res = await inbound('POST', '/org-units', {
      key: writeKey,
      body: { records: [
        { UnitCode: 'HR', UnitNameEn: 'Human Resources', UnitNameAr: 'الموارد البشرية', ParentUnitCode: 'OPS' },
        { UnitCode: 'ER', UnitNameEn: 'Employee Relations', UnitNameAr: 'علاقات الموظفين', ParentUnitCode: 'HR' },
        { UnitCode: 'L1', UnitNameEn: 'Loop 1', ParentUnitCode: 'L2' },
        { UnitCode: 'L2', UnitNameEn: 'Loop 2', ParentUnitCode: 'L1' },
      ] },
    });
    expect(res.status).toBe(202);
    expect(res.json.data).toMatchObject({ kind: 'ORG_UNITS', totalRows: 4, validRows: 2, errorRows: 2 });
    const status = await inbound('GET', `/batches/${res.json.data.batchId}`, { key: writeKey });
    expect(status.json.data.errors.map((e: { rowNo: number; message: string }) => [e.rowNo, e.message])).toEqual([
      [3, 'This parent would create a cycle in the department tree'],
      [4, 'This parent would create a cycle in the department tree'],
    ]);
  });

  it('rate-limits each key', async () => {
    const res = await createKey(F.ownerA, F.orgA, { name: 'flood', scopes: ['hrms:read'] });
    const secret: string = res.json.data.secret;
    let last = 0;
    for (let i = 0; i <= HRMS_INBOUND_LIMITS.perKey.max && last !== 429; i += 1) last = (await inbound('GET', `/batches/${batchId}`, { key: secret })).status;
    expect(last).toBe(429);
    // another key is not affected
    expect((await inbound('GET', `/batches/${batchId}`, { key: writeKey })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// import page: org units and .xlsx
// ---------------------------------------------------------------------------------------------------------------------------

/** A ZIP archive (deflated entries) — enough to build an .xlsx workbook in a test. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8'); const data = deflateRawSync(raw); const nameBuf = Buffer.from(name, 'utf8'); const crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** One-sheet workbook: shared strings for text, numbers as numbers, `date` cells as serials with a date style. */
function xlsx(rows: Array<Array<string | number | { date: string }>>): Buffer {
  const strings: string[] = [];
  const si = (s: string) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const col = (i: number) => String.fromCharCode(65 + i);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${col(ci)}${ri + 1}`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'object') return `<c r="${ref}" s="1"><v>${(Date.parse(`${v.date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000}</v></c>`;
    return v === '' ? '' : `<c r="${ref}" t="s"><v>${si(v)}</v></c>`;
  }).join('')}</row>`).join('');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Staff" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  });
}

describe('import page: .xlsx and org units', () => {
  it('reads an .xlsx workbook (shared strings, numbers, date cells, Arabic) like a CSV', async () => {
    const book = xlsx([
      ['employeeNumber', 'firstName', 'lastName', 'displayNameAr', 'joiningDate', 'branchCode', 'deviceUserId', 'employmentType'],
      ['X-001', 'Huda', 'Al Hinai', 'هدى الهنائية', { date: '2026-09-15' }, 'A-HQ', 501, 'Full Time'],
      ['X-002', 'R & D', 'Lab', '', { date: '2026-09-16' }, 'NOPE', 502, ''],
    ]);
    const res = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'staff.xlsx', contentBase64: b64(book) } });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ totalRows: 2, validRows: 1, errorRows: 1, summary: { format: 'xlsx' } });
    expect(res.json.data.preview[0].data).toMatchObject({ employeeNumber: 'X-001', displayNameAr: 'هدى الهنائية', joiningDate: '2026-09-15', deviceUserId: '501', employmentType: 'full_time', branchId: F.branchHQ });
    expect(res.json.data.preview[1].data).toMatchObject({ firstName: 'R & D' });
    // a damaged workbook is a 400 that does not echo the file
    const broken = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'staff.xlsx', contentBase64: b64(book.subarray(0, 200)) } });
    expect(broken.status).toBe(400);
    expect(broken.json.message).toMatch(/not a readable Excel workbook/);
  });

  it('updates existing employees with partial rows; a civil ID needs employee.view_sensitive and is masked without it', async () => {
    const csv = 'employeeNumber,firstName,lastName,joiningDate,branchCode,civilId\nE-001,,,,,11223344\n';
    const hr = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.hrUserA, body: { fileName: 'u.csv', contentBase64: b64(csv), options: { updateExisting: true } } });
    expect(hr.status).toBe(201);
    expect(hr.json.data.preview[0].errors).toEqual([{ field: 'civilId', message: 'Importing civil IDs needs the employee.view_sensitive permission' }]);
    expect(hr.json.data.preview[0].data.civilId).toBe('****3344');
    const owner = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'u.csv', contentBase64: b64(csv), options: { updateExisting: true } } });
    expect(owner.json.data.preview[0]).toMatchObject({ status: 'valid', data: { existingEmployeeId: F.empE1, civilId: '11223344' } });
    expect(owner.json.data.preview[0].data.firstName).toBeUndefined(); // an empty cell leaves the stored value alone
  });

  it('org units: template, permission (department.manage), parents in the file, loops and unknown parents refused', async () => {
    const tpl = await api.request('GET', `/orgs/${F.orgA}/employees/imports/template?kind=ORG_UNITS`, { user: F.ownerA });
    expect(tpl.text.split('\n')[0]).toBe('code,name,nameAr,parentCode,branchCode,managerEmployeeNumber,status');
    const csv = [
      'code,name,nameAr,parentCode,branchCode,managerEmployeeNumber',
      'FIN,Finance,المالية,OPS,A-HQ,E-001',
      'FIN-AP,Payables,,FIN,,',
      'C1,Cycle one,,C2,,',
      'C2,Cycle two,,C1,,',
      'ORPHAN,Orphan,,NOWHERE,,',
      'SALES,Sales (renamed),,,,',
    ].join('\n');
    const denied = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.hrUserA, body: { fileName: 'units.csv', contentBase64: b64(csv), kind: 'ORG_UNITS' } });
    expect(denied.status).toBe(403);
    const res = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'units.csv', contentBase64: b64(csv), kind: 'ORG_UNITS' } });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ type: 'ORG_UNITS', totalRows: 6, validRows: 3, errorRows: 3 });
    const p = res.json.data.preview;
    expect(p[0]).toMatchObject({ status: 'valid', data: { code: 'FIN', parentId: F.deptOps, branchId: F.branchHQ, managerEmployeeId: F.empE1 } });
    expect(p[1]).toMatchObject({ status: 'valid', data: { code: 'FIN-AP', parentCode: 'FIN' } });
    expect(p[2].errors[0].message).toBe('This parent would create a cycle in the department tree');
    expect(p[3].errors[0].message).toBe('This parent would create a cycle in the department tree');
    expect(p[4].errors[0].message).toBe('Parent "NOWHERE" not found in the organisation or in this file');
    expect(p[5]).toMatchObject({ status: 'valid', data: { existingDepartmentId: F.deptSales } });
    // a loop through the existing tree: OPS is the parent of SALES, so OPS under SALES is refused
    const loop = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'loop.csv', contentBase64: b64('code,name,parentCode\nOPS,Operations,SALES\n'), kind: 'ORG_UNITS' } });
    expect(loop.json.data.preview[0].errors[0].message).toBe('This parent would create a cycle in the department tree');
    const confirm = await api.request('POST', `/orgs/${F.orgA}/employees/imports/${res.json.data.id}/confirm`, { user: F.ownerA });
    expect(confirm.status).toBe(202);
    const queued = await api.tdb.adminDb.selectFrom('jobs.queue').select('payload').where('id', '=', confirm.json.data.jobId).executeTakeFirstOrThrow();
    expect(queued.payload).toMatchObject({ organizationId: F.orgA, importJobId: res.json.data.id });
  });
});
