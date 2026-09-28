import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/portal-attendance.json';
import ar from '@/locales/ar/portal-attendance.json';

/** Namespace of the portal's attendance self-service (HR portal Prompt 4): check-in, reasons, regularisation, shift, stats. */
export const PA_NS = 'portal-attendance';
registerNamespace(PA_NS, en, ar);
