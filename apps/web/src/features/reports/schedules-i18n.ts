import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/report-schedules.json';
import ar from '@/locales/ar/report-schedules.json';
import reportsEn from '@/locales/en/reports.json';
import reportsAr from '@/locales/ar/reports.json';

/** Report sharing and schedule strings (HR portal Prompt 6a); imported for its side effect. Registration is idempotent. */
registerNamespace('reportSchedules', en, ar);
registerNamespace('reports', reportsEn, reportsAr);
