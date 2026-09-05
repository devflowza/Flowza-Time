import i18n from './i18n';

/**
 * Feature modules register their own translation namespace (en + ar) at import time:
 *   registerNamespace('employees', en, ar); then useTranslation('employees').
 */
export function registerNamespace(ns: string, en: Record<string, unknown>, ar: Record<string, unknown>) {
  if (!i18n.hasResourceBundle('en', ns)) i18n.addResourceBundle('en', ns, en, true, true);
  if (!i18n.hasResourceBundle('ar', ns)) i18n.addResourceBundle('ar', ns, ar, true, true);
}
