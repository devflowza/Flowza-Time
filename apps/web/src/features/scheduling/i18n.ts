import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/scheduling.json';
import ar from '@/locales/ar/scheduling.json';

/**
 * Namespace of round-the-clock scheduling (Enterprise, module advanced_scheduling): the shifts page's round-the-clock,
 * coverage and double-shift tabs, the branch deployments page, the muster page ("On site now"), their sidebar entries and the
 * portal's deployment banner. Imported by every module that renders its strings.
 */
export const SCHED_NS = 'scheduling';
registerNamespace(SCHED_NS, en, ar);
