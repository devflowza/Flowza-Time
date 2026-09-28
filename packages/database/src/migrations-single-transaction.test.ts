import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The hosted apply runs every migration file as ONE transaction, and `CREATE INDEX CONCURRENTLY` (or `DROP INDEX
 * CONCURRENTLY`, `REINDEX … CONCURRENTLY`) cannot run inside one: a migration that avoided a lock that way would fail on the
 * hosted project. Notifications review 8-P2-7 (decision): the two retention indexes of 20260928001000 stay plain
 * `create index if not exists` under `lock_timeout`, and the file's runbook tells the operator to build them CONCURRENTLY out
 * of band first on a large table — the migration then finds them and does nothing.
 */
const DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
/** The statements of a migration without its comments (a runbook may mention CONCURRENTLY; a statement may not). */
const executable = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

describe('migrations are single-transaction safe', () => {
  it('8-P2-7 no migration statement runs CONCURRENTLY; the notifications retention indexes keep their out-of-band runbook', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(30);
    expect(files.filter((f) => /\bconcurrently\b/i.test(executable(readFileSync(DIR + f, 'utf8'))))).toEqual([]);
    const v2 = readFileSync(`${DIR}20260928001000_notifications_v2.sql`, 'utf8');
    for (const index of ['notifications_org_read_created_idx', 'notification_deliveries_org_settled_idx']) {
      expect(executable(v2), index).toMatch(new RegExp(`create index if not exists ${index} on `, 'i'));
    }
    expect(v2).toMatch(/out of band with `create index concurrently if not exists/i);
    expect(readFileSync(`${DIR}20260928001050_notifications_review_fixes.sql`, 'utf8')).toMatch(/8-P2-7 — no DDL: the two partial indexes of 20260928001000 stay non-concurrent/);
  });
});
