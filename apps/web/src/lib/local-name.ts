import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A master-data name (a holiday, a leave type) in the UI language: the organisation's Arabic name when the UI is in Arabic
 * and one was given, otherwise the name. Mirrors the dashboard's holidays card; the employee portal uses it so an Arabic
 * reader does not meet "Annual Leave" and "National Day" in Latin script between Arabic labels.
 */
export function localName(lng: string | null | undefined, name: string, nameAr?: string | null): string {
  return lng?.split('-')[0]?.toLowerCase() === 'ar' && nameAr?.trim() ? nameAr : name;
}

/** `localName` bound to the current UI language (re-renders on a language change). */
export function useLocalName(): (name: string, nameAr?: string | null) => string {
  const { i18n } = useTranslation();
  const lng = i18n?.resolvedLanguage ?? i18n?.language;
  return useCallback((name: string, nameAr?: string | null) => localName(lng, name, nameAr), [lng]);
}
