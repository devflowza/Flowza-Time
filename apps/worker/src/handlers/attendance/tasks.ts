import { sql } from 'kysely';
import { withContext } from '@flowza/database';
import type { ScheduledTask } from '../../scheduler.js';
import { enqueueNormalizeRaw } from './common.js';

/**
 * Attendance scheduler ticks (enqueue-only). The normaliser is normally triggered by ingestion; this sweep catches raw rows
 * that arrived without a trigger (push endpoints, imports, crashed jobs) — a platform scan on the whitelisted
 * `attendance_raw_transactions` (select only) followed by one deduped NORMALIZE_RAW per organisation.
 */
export const attendanceTasks: ScheduledTask[] = [
  {
    name: 'normalize-sweep',
    everyMs: 60_000,
    run: async (d) => {
      const orgs = await withContext(d.db, { kind: 'platform' }, (trx) =>
        sql<{ organizationId: string }>`select distinct organization_id as "organizationId" from public.attendance_raw_transactions where processing_status = 'pending'`.execute(trx));
      for (const o of orgs.rows) await enqueueNormalizeRaw(d.queue, o.organizationId);
      return { organizations: orgs.rows.length };
    },
  },
];
