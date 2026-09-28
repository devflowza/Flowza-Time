import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/attendance-review.json';
import ar from '@/locales/ar/attendance-review.json';

/** Namespace of the manager / HR review surfaces of HR portal Prompt 4: reasons, selfies, attendance grants, geofences. */
export const AR_NS = 'attendance-review';
registerNamespace(AR_NS, en, ar);
