/** Regenerates src/generated/db.ts from a migrated database. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL_ADMIN ?? 'postgres://postgres@127.0.0.1:54329/flowza';
execFileSync('pnpm', ['exec', 'kysely-codegen', '--dialect', 'postgres', '--url', url, '--out-file', path.resolve(here, '../generated/db.ts'),
  '--default-schema', 'public', '--include-pattern', '{public,jobs,audit}.*', '--exclude-pattern', '*.*_default', '--exclude-pattern', '*.*_20[0-9][0-9][0-9][0-9]', '--camel-case'],
  { stdio: 'inherit', cwd: path.resolve(here, '../..') });
