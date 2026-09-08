import { describe, expect, it } from 'vitest';
import { looksLikeTransactionPooler } from './config.js';

describe('looksLikeTransactionPooler', () => {
  it('flags the transaction pooler, which silently breaks scheduler leader election', () => {
    expect(looksLikeTransactionPooler('postgresql://flowza_worker.abc:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres')).toBe(true);
  });

  it('accepts the session pooler and a direct connection', () => {
    expect(looksLikeTransactionPooler('postgresql://flowza_worker.abc:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres')).toBe(false);
    expect(looksLikeTransactionPooler('postgresql://postgres:postgres@127.0.0.1:54329/flowza')).toBe(false);
  });

  it('stays quiet on a connection string it cannot parse', () => {
    expect(looksLikeTransactionPooler('not a url')).toBe(false);
  });
});
