import type { HandlerRegistry } from '../types.js';
import { executeImport } from './execute.js';

/** EXECUTE_IMPORT: applies a confirmed import / an HR system batch (./execute.ts, docs/integrations/hrms.md §4). */
export function registerImportHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'EXECUTE_IMPORT', handler: executeImport, timeoutMs: 30 * 60_000 });
}
