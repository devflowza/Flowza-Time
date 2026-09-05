import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from '../locales/en/common.json';
import ar from '../locales/ar/common.json';

export const SUPPORTED_LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const RTL_LOCALES: Locale[] = ['ar'];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { common: en }, ar: { common: ar } },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LOCALES,
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage', 'navigator'], lookupLocalStorage: 'flowza.locale', caches: ['localStorage'] },
    returnNull: false,
  });

export function applyDirection(lng: string) {
  const dir = RTL_LOCALES.includes(lng as Locale) ? 'rtl' : 'ltr';
  document.documentElement.setAttribute('dir', dir);
  document.documentElement.setAttribute('lang', lng);
}
i18n.on('languageChanged', applyDirection);
applyDirection(i18n.language);

export default i18n;
