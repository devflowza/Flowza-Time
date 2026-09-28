import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as main from './index.js';
import * as testing from './testing.js';

describe('package entry points (review D18)', () => {
  it('the production entry that the API and worker import carries no test helper — the mock Finance server lives behind ./testing', () => {
    const exported = Object.keys(main);
    for (const name of ['createMockFinanceServer', 'financePunchFixtures', 'encodeFinanceCursor', 'createTestProviderContext']) expect(exported, name).not.toContain(name);
    expect(typeof testing.createMockFinanceServer).toBe('function');
    expect(typeof testing.financePunchFixtures).toBe('function');
    expect(typeof testing.createTestProviderContext).toBe('function');
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { exports: Record<string, { default: string; types: string }> };
    expect(pkg.exports['./testing']).toEqual({ types: './dist/testing.d.ts', default: './dist/testing.js' });
    expect(pkg.exports['.']!.default).toBe('./dist/index.js');
  });
});
