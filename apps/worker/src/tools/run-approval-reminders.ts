/**
 * Dev hook — LOCAL DEVELOPMENT ONLY: run the approvals sweep (escalation of overdue levels, the 24-hour reminders, the
 * daily digest — `runApprovalReminders`) ONCE for one organisation, with an injected clock. The end-to-end matrix
 * (`scripts/e2e-hosted/run.mjs`, flow 8) uses it to make an escalation that is due in hours due now, through the real
 * handler and without touching the database by hand.
 *
 *   pnpm --filter @flowza/worker exec tsx src/tools/run-approval-reminders.ts --org=<organisation uuid> [--now=<ISO instant>]
 *
 * Reads the worker's own environment (DATABASE_URL_WORKER, FLOWZA_CREDENTIALS_MASTER_KEYS, …). Refuses to run with
 * NODE_ENV=production or against a database that is not on this machine: a clock injected into production would escalate
 * and remind real approvers early. Prints one JSON line: `{ organizationId, now, escalated, reminded, digests }`.
 */
import { createDatabase, DeviceCredentialsStore, PgJobQueue, SecretsCipher } from '@flowza/database';
import { defaultRegistry } from '@flowza/device-providers';
import { createLogger } from '@flowza/shared';
import { loadWorkerConfig } from '../config.js';
import type { WorkerDeps } from '../deps.js';
import { runApprovalReminders } from '../handlers/approvals/reminders.js';
import { createMailer, createPlatformClients } from '../lib/platform.js';
import { createPdfRenderer } from '../lib/pdf.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The parsed command line, or an error message. Exported for the unit test. */
export function parseArgs(argv: readonly string[]): { orgId: string; now: Date } | { error: string } {
  const opts = new Map<string, string>();
  for (const a of argv) {
    const m = /^--(org|now)=(.+)$/.exec(a);
    if (!m) return { error: `unknown argument ${a}` };
    opts.set(m[1]!, m[2]!);
  }
  const orgId = opts.get('org');
  if (!orgId || !UUID.test(orgId)) return { error: '--org=<organisation uuid> is required' };
  const now = opts.has('now') ? new Date(opts.get('now')!) : new Date();
  if (Number.isNaN(now.getTime())) return { error: '--now must be an ISO instant' };
  return { orgId, now };
}

/** Only a local, non-production worker may run it (see the file header). Exported for the unit test. */
export function refusal(env: { NODE_ENV: string; DATABASE_URL_WORKER: string }): string | null {
  if (env.NODE_ENV === 'production') return 'refusing to inject a clock with NODE_ENV=production';
  let host: string;
  try { host = new URL(env.DATABASE_URL_WORKER).hostname; } catch { return 'DATABASE_URL_WORKER is not a URL'; }
  return LOOPBACK.has(host) ? null : `refusing to run against a non-local database host (${host})`;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) { console.error(`run-approval-reminders: ${parsed.error}`); return 2; }
  const config = loadWorkerConfig();
  const refused = refusal(config);
  if (refused) { console.error(`run-approval-reminders: ${refused}`); return 3; }
  const log = createLogger({ name: 'flowza-worker-tool', level: config.LOG_LEVEL });
  const { db, pool } = createDatabase({ connectionString: config.DATABASE_URL_WORKER, max: 2, applicationName: 'flowza-worker-tool', ssl: false });
  const platform = createPlatformClients(config, log);
  const deps: WorkerDeps = {
    config, log, db, queue: new PgJobQueue(db),
    credentials: new DeviceCredentialsStore(new SecretsCipher(config.FLOWZA_CREDENTIALS_MASTER_KEYS)),
    providers: defaultRegistry({ flowzaFinance: { allowPrivateHosts: config.FLOWZA_ALLOW_PRIVATE_EGRESS }, vendorHttp: { allowPrivateHosts: config.FLOWZA_ALLOW_PRIVATE_EGRESS } }),
    realtime: platform.realtime, storage: platform.storage, mailer: createMailer(config, log), pdf: createPdfRenderer(config, log),
    now: () => parsed.now,
  };
  try {
    const result = await runApprovalReminders(deps, parsed.orgId);
    console.log(JSON.stringify({ organizationId: parsed.orgId, now: parsed.now.toISOString(), ...result }));
    return 0;
  } finally {
    await db.destroy().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

// run only when executed directly (the unit test imports the pure helpers)
if (process.argv[1] && /run-approval-reminders\.(ts|js)$/.test(process.argv[1])) {
  main().then((code) => process.exit(code), (err: unknown) => { console.error(`run-approval-reminders: ${(err as Error).message}`); process.exit(1); });
}
