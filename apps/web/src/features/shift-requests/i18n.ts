import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/shift-requests.json';
import ar from '@/locales/ar/shift-requests.json';

/** Namespace of the Enterprise shift change requests (module shift_requests): the portal dialog and list, the HR tab, the inbox context. */
export const SR_NS = 'shift-requests';
registerNamespace(SR_NS, en, ar);
