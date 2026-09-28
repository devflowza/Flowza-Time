import { describe, expect, it } from 'vitest';
import { parseArgs, refusal } from './run-approval-reminders.js';

const ORG = '00000000-0000-4000-a000-000000000001';

describe('run-approval-reminders dev hook (end-to-end matrix, flow 8)', () => {
  it('needs an organisation uuid and reads an optional ISO clock', () => {
    const at = '2026-09-28T20:00:00.000Z';
    expect(parseArgs([`--org=${ORG}`, `--now=${at}`])).toEqual({ orgId: ORG, now: new Date(at) });
    const noClock = parseArgs([`--org=${ORG}`]);
    expect('error' in noClock ? null : Math.abs(noClock.now.getTime() - Date.now())).toBeLessThan(5_000);
    expect(parseArgs([])).toEqual({ error: '--org=<organisation uuid> is required' });
    expect(parseArgs(['--org=not-a-uuid'])).toEqual({ error: '--org=<organisation uuid> is required' });
    expect(parseArgs([`--org=${ORG}`, '--now=yesterday'])).toEqual({ error: '--now must be an ISO instant' });
    expect(parseArgs([`--org=${ORG}`, '--force'])).toEqual({ error: 'unknown argument --force' });
  });

  it('runs only against a database on this machine and never with NODE_ENV=production', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(refusal({ NODE_ENV: 'development', DATABASE_URL_WORKER: `postgres://flowza_worker:x@${host}:54329/flowza` })).toBeNull();
    }
    expect(refusal({ NODE_ENV: 'test', DATABASE_URL_WORKER: 'postgres://u:p@127.0.0.1:5432/db' })).toBeNull();
    expect(refusal({ NODE_ENV: 'production', DATABASE_URL_WORKER: 'postgres://u:p@127.0.0.1:5432/db' })).toMatch(/NODE_ENV=production/);
    expect(refusal({ NODE_ENV: 'development', DATABASE_URL_WORKER: 'postgres://u:p@db.ucjtxdmklhhhvayirwqe.supabase.co:5432/postgres' })).toMatch(/non-local database host/);
    expect(refusal({ NODE_ENV: 'development', DATABASE_URL_WORKER: 'not a url' })).toMatch(/not a URL/);
  });
});
