import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deviceCapabilitiesSchema, providerConfigSchemaSchema, providerThrottlingSchema } from '@flowza/contracts';
import { createProviderRegistry, defaultRegistry, definitionToRow, PROVIDER_SORT_ORDER, secretFieldsOf } from './registry.js';
import { defineProvider } from './definition.js';
import { createMockProvider } from './providers/mock/mock-provider.js';
import { ProviderError } from './types.js';

const EXPECTED_KEYS = ['mock', 'zkteco_push', 'zkteco_biotime', 'hikvision_isapi', 'hikvision_hpp', 'suprema_biostar2', 'anviz_crosschex_cloud', 'essl_push', 'fingertec_push', 'matrix_cosec', 'nitgen'];
const SQL_PATH = resolve(import.meta.dirname, '../../../supabase/migrations/20260905001600_reference_data.sql');

type SqlValue = string | number | null;
/** Minimal tokenizer for the `insert into … values (…),(…)` block of the reference-data migration. */
function parseInsertRows(sql: string, table: string): SqlValue[][] {
  const start = sql.indexOf(`insert into public.${table} (`);
  const valuesIdx = sql.indexOf(') values', start);
  const end = sql.indexOf('on conflict', valuesIdx);
  const block = sql.slice(valuesIdx + ') values'.length, end);
  const rows: SqlValue[][] = [];
  let row: SqlValue[] | null = null;
  let i = 0;
  while (i < block.length) {
    const ch = block[i] ?? '';
    if (row === null) { if (ch === '(') row = []; i += 1; continue; }
    if (ch === ')') { rows.push(row); row = null; i += 1; continue; }
    if (ch === "'") {
      let j = i + 1; let s = '';
      while (j < block.length) {
        if (block[j] === "'") { if (block[j + 1] === "'") { s += "'"; j += 2; continue; } break; }
        s += block[j]; j += 1;
      }
      row.push(s); i = j + 1; continue;
    }
    if (/[0-9-]/.test(ch)) { let j = i; while (j < block.length && /[0-9.-]/.test(block[j] ?? '')) j += 1; row.push(Number(block.slice(i, j))); i = j; continue; }
    if (block.startsWith('null', i)) { row.push(null); i += 4; continue; }
    i += 1;
  }
  return rows;
}
const COLS = ['key', 'vendor', 'name', 'description', 'integration_type', 'status', 'capabilities', 'config_schema', 'throttling', 'verification_status', 'docs_url', 'sort_order'] as const;
function referenceRows(): Map<string, Record<(typeof COLS)[number], SqlValue>> {
  const rows = parseInsertRows(readFileSync(SQL_PATH, 'utf8'), 'device_providers');
  const out = new Map<string, Record<(typeof COLS)[number], SqlValue>>();
  for (const r of rows) {
    expect(r).toHaveLength(COLS.length);
    const rec = Object.fromEntries(COLS.map((c, i) => [c, r[i] ?? null])) as Record<(typeof COLS)[number], SqlValue>;
    out.set(String(rec.key), rec);
  }
  return out;
}

describe('createProviderRegistry', () => {
  it('resolves providers by key and throws NOT_FOUND otherwise', () => {
    const reg = createProviderRegistry([createMockProvider()]);
    expect(reg.get('mock').definition.key).toBe('mock');
    expect(reg.tryGet('nope')).toBeUndefined();
    expect(() => reg.get('nope')).toThrow(ProviderError);
    try { reg.get('nope'); } catch (e) { expect(ProviderError.is(e) && e.code === 'NOT_FOUND' && !e.retryable).toBe(true); }
  });
  it('rejects duplicate keys and conflicting protocol handlers', () => {
    expect(() => createProviderRegistry([createMockProvider(), createMockProvider()])).toThrow(/registered twice/);
    const a = createMockProvider();
    const b = createMockProvider();
    const clone = Object.create(b, { definition: { value: defineProvider({ ...b.definition, key: 'mock2' }) } }) as typeof b;
    expect(() => createProviderRegistry([a, clone])).toThrow(/push protocol/);
  });
  it('defaultRegistry wires every reference provider and dedupes shared protocol handlers', () => {
    const reg = defaultRegistry();
    expect(reg.list().map((d) => d.key)).toEqual(EXPECTED_KEYS);
    expect(reg.pushProtocols().map((p) => p.protocolKey).sort()).toEqual(['iclock', 'mock']);
    expect(reg.pushProtocol('iclock')).toBe(reg.get('zkteco_push').pushProtocol);
    expect(reg.get('essl_push').pushProtocol).toBe(reg.get('zkteco_push').pushProtocol);
    expect(reg.pushProtocol('nope')).toBeUndefined();
    for (const d of reg.list()) expect(d.secretFields).toEqual(secretFieldsOf(d.configSchema));
  });
});

describe('secretFieldsOf', () => {
  it('flags secret:true and any password-typed field', () => {
    expect(secretFieldsOf({ fields: [
      { key: 'a', label: 'a', type: 'text', required: false, secret: false },
      { key: 'b', label: 'b', type: 'password', required: false, secret: false },
      { key: 'c', label: 'c', type: 'text', required: false, secret: true },
    ] })).toEqual(['b', 'c']);
  });
});

describe('definitionToRow ⇄ reference data (supabase/migrations/*_reference_data.sql)', () => {
  const ref = referenceRows();
  const reg = defaultRegistry();

  it('covers exactly the keys in the migration', () => {
    expect([...ref.keys()].sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  for (const def of reg.list()) {
    it(`${def.key} matches its device_providers row`, () => {
      const sql = ref.get(def.key);
      expect(sql).toBeDefined();
      if (!sql) return;
      const row = definitionToRow(def);
      expect(row.key).toBe(sql.key);
      expect(row.vendor).toBe(sql.vendor);
      expect(row.name).toBe(sql.name);
      expect(row.description).toBe(sql.description);
      expect(row.integration_type).toBe(sql.integration_type);
      expect(row.status).toBe(sql.status);
      expect(row.verification_status).toBe(sql.verification_status);
      expect(row.docs_url).toBe(sql.docs_url);
      expect(row.sort_order).toBe(sql.sort_order);
      expect(PROVIDER_SORT_ORDER[def.key]).toBe(sql.sort_order);
      expect(row.capabilities).toEqual(deviceCapabilitiesSchema.parse(JSON.parse(String(sql.capabilities))));
      expect(row.throttling).toEqual(providerThrottlingSchema.parse(JSON.parse(String(sql.throttling))));
      const sqlSchema = providerConfigSchemaSchema.parse(JSON.parse(String(sql.config_schema)));
      if (def.key === 'mock') {
        // The simulator exposes extra scenarios/fields beyond the seeded row; the seeded row must be a subset.
        for (const f of sqlSchema.fields) {
          const mine = row.config_schema.fields.find((x) => x.key === f.key);
          expect(mine, `mock field ${f.key}`).toBeDefined();
          expect(mine?.type).toBe(f.type);
          expect(mine?.secret).toBe(f.secret);
          for (const o of f.options ?? []) expect(mine?.options).toContain(o);
        }
      } else {
        expect(row.config_schema).toEqual(sqlSchema);
      }
    });
  }

  it('produces JSON-serialisable rows with only snake_case columns', () => {
    const row = definitionToRow(reg.get('zkteco_push').definition, { sortOrder: 7 });
    expect(Object.keys(row).sort()).toEqual([...COLS].sort());
    expect(row.sort_order).toBe(7);
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });
});

describe('defineProvider', () => {
  it('fills capability defaults, derives secretFields and freezes the result', () => {
    const d = defineProvider({ key: 'x_y', vendor: 'v', name: 'n', description: '', integrationType: 'LAN', status: 'placeholder', capabilities: { card: true }, configSchema: { fields: [{ key: 'p', label: 'p', type: 'password', required: true, secret: false }] }, throttling: {}, verificationStatus: 'UNVERIFIED' });
    expect(d.capabilities.card).toBe(true);
    expect(d.capabilities.face).toBe(false);
    expect(d.secretFields).toEqual(['p']);
    expect(Object.isFrozen(d)).toBe(true);
  });
  it('rejects invalid keys, duplicate fields and bad throttling', () => {
    const base = { vendor: 'v', name: 'n', description: '', integrationType: 'LAN' as const, status: 'placeholder' as const, capabilities: {}, configSchema: { fields: [] }, throttling: {}, verificationStatus: 'UNVERIFIED' as const };
    expect(() => defineProvider({ ...base, key: 'Bad-Key' })).toThrow(ProviderError);
    expect(() => defineProvider({ ...base, key: 'ok', configSchema: { fields: [{ key: 'a', label: 'a', type: 'text', required: false, secret: false }, { key: 'a', label: 'b', type: 'text', required: false, secret: false }] } })).toThrow(/Duplicate/);
    expect(() => defineProvider({ ...base, key: 'ok', throttling: { requestsPerMinute: 0 } })).toThrow(ProviderError);
  });
});
