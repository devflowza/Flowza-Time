import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/attendance-admin.json';
import ar from '@/locales/ar/attendance-admin.json';

/** Namespace of the HR attendance administration surfaces of HR portal Prompt 6b: the regularisation register and the comments report. */
export const AA_NS = 'attendance-admin';
registerNamespace(AA_NS, en, ar);
