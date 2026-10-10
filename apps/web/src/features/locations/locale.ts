import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/locations.json';
import ar from '@/locales/ar/locations.json';

/** The `locations` translation namespace (en + ar). Importing this module registers it; registering twice is harmless. */
export const LOCATIONS_NS = 'locations';
registerNamespace(LOCATIONS_NS, en, ar);
