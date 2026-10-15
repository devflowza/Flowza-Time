import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/time-away.json';
import ar from '@/locales/ar/time-away.json';

/**
 * Namespace of the HR time-away report (docs/time-away.md): /attendance/time-away — monthly totals per employee (official duty,
 * personal permission, unapproved) and the requests behind them — and its sidebar entry.
 */
export const TIME_AWAY_NS = 'time-away';
registerNamespace(TIME_AWAY_NS, en, ar);
