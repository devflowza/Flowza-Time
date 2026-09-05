/** Entry point for the deterministic seed. Implementation lives in ./seed/ (see docs/development.md). */
import { runSeed } from '../seed/index.js';

runSeed({ connectionString: process.env.DATABASE_URL_ADMIN ?? 'postgres://postgres@127.0.0.1:54329/flowza' }).then(
  (summary) => { console.warn('seed complete', summary); },
  (err) => { console.error(err); process.exit(1); },
);
