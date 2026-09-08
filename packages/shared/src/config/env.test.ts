import { describe, expect, it } from 'vitest';
import { databaseSslDefault } from './env.js';

describe('databaseSslDefault', () => {
  it('enables TLS for a managed pooler reached over the network', () => {
    expect(databaseSslDefault('postgresql://flowza_api.abc:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres')).toBe(true);
  });

  it('leaves the local development database alone', () => {
    expect(databaseSslDefault('postgresql://postgres:postgres@127.0.0.1:54329/flowza')).toBe(false);
    expect(databaseSslDefault('postgresql://postgres:postgres@localhost:5432/flowza')).toBe(false);
    expect(databaseSslDefault('postgresql://postgres:postgres@[::1]:5432/flowza')).toBe(false);
  });

  it('honours an explicit sslmode in the URL', () => {
    expect(databaseSslDefault('postgresql://u:p@db.example.com:5432/postgres?sslmode=disable')).toBe(false);
    expect(databaseSslDefault('postgresql://u:p@127.0.0.1:5432/postgres?sslmode=require')).toBe(true);
    expect(databaseSslDefault('postgresql://u:p@db.example.com:5432/postgres?sslmode=verify-full')).toBe(true);
  });

  it('fails towards TLS when the connection string cannot be parsed', () => {
    expect(databaseSslDefault('not a url')).toBe(true);
  });
});
