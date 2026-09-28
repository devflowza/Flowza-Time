import { useTranslation } from 'react-i18next';

export type Direction = 'ltr' | 'rtl';

/** Languages written right to left. The one list behind the document's `dir` (lib/i18n) and the UI kit's Radix roots. */
export const RTL_LANGUAGES: readonly string[] = ['ar'];

/** The reading direction of a language tag ('ar', 'ar-OM' → rtl). */
export function directionOf(lng: string | null | undefined): Direction {
  return lng && RTL_LANGUAGES.includes(lng.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr';
}

/**
 * The direction of the current UI language, re-rendering when the language changes.
 *
 * Radix primitives that lay out by direction (Tabs, Select, DropdownMenu) do not read the document's `dir`: without a
 * DirectionProvider they fall back to 'ltr', and Tabs even writes `dir="ltr"` on its root element — which turned whole tab
 * panels (tables, forms, the row actions of the HR reasons review) left-to-right in Arabic. The UI kit therefore passes this
 * direction to those roots explicitly; a caller's own `dir` still wins.
 */
export function useUiDirection(): Direction {
  const { i18n } = useTranslation();
  return directionOf(i18n?.resolvedLanguage ?? i18n?.language);
}
