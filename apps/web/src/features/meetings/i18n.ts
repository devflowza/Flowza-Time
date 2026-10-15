import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/meetings.json';
import ar from '@/locales/ar/meetings.json';

/**
 * Namespace of meeting rooms & access (Enterprise, module meeting_rooms — docs/time-away.md §4): the meetings page (meetings,
 * rooms, access log) and its sidebar entry. Imported by every module that renders its strings.
 */
export const MEETINGS_NS = 'meetings';
registerNamespace(MEETINGS_NS, en, ar);
