import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/policies.json';
import ar from '@/locales/ar/policies.json';
import scheduleEn from '@/locales/en/schedule.json';
import scheduleAr from '@/locales/ar/schedule.json';

/** Namespace of the global attendance policies (Enterprise, attendance_policies): groups, points, overtime summary, packs. */
export const POLICIES_NS = 'policies';
registerNamespace(POLICIES_NS, en, ar);
// the policy editor (features/schedule rule-set-dialog) opens from the country packs tab
registerNamespace('schedule', scheduleEn, scheduleAr);
