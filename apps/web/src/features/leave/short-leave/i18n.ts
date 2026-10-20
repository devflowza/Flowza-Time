import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/short-leave.json';
import ar from '@/locales/ar/short-leave.json';

/** Namespace of short leave (hourly permissions, official assignment, remote work, reduced hours): HR tabs, portal, profile, inbox. */
export const SL_NS = 'short-leave';
registerNamespace(SL_NS, en, ar);
