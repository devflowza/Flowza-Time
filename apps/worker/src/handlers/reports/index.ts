import type { HandlerRegistry } from '../types.js';
import { registerReportHandlers as registerGenerateHandlers } from './generate.js';
import { registerDeliveryHandlers } from './deliveries.js';

/** GENERATE_REPORT, EXPORT_EMPLOYEES and RUN_REPORT_SCHEDULE (report sharing / schedules, HR portal Prompt 6a). */
export function registerReportHandlers(registry: HandlerRegistry): void {
  registerGenerateHandlers(registry);
  registerDeliveryHandlers(registry);
}
export { generateReportHandler, exportEmployeesHandler, generateReportRequest, REPORT_FILE_TTL_DAYS, REPORTS_BUCKET } from './generate.js';
export { REPORT_DELIVERY_JOB_TYPE, runReportDelivery, runReportDeliveryHandler, deliverRun, settleDelivery, periodOfParameters, reportDeliveryPayloadSchema } from './deliveries.js';
export { REPORT_DEFINITIONS } from './definitions/index.js';
export type { ReportDocument } from './model.js';
