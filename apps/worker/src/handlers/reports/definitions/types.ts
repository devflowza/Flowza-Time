import type { ReportType } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { ReportContext } from '../context.js';
import type { ReportDocument } from '../model.js';

/** One report type: loads its data inside the tenant's system context and returns the renderer-neutral document. */
export interface ReportDefinition {
  key: ReportType;
  build(trx: Trx, ctx: ReportContext): Promise<ReportDocument>;
}
