import type { ApprovalEntity, NotificationLocale, ReportType, SyncJobType } from '@flowza/contracts';

/**
 * One notification template. Variables are written `{{name}}` or `{{name|fallback}}`; every value is plain text (the e-mail
 * layout escapes it for HTML). A body is a list of parts joined with the locale's separator: a part that references a
 * variable without a value (and without a fallback) is left out, so a missing variable never prints as "undefined" or as a
 * dangling label. `bodyFallback` is used when every part was left out.
 */
export interface NotificationTemplate {
  /** In-app title and, by default, the e-mail heading and subject. */
  title: string;
  body: readonly string[];
  bodyFallback?: string;
  /** E-mail subject (defaults to the title). */
  subject?: string;
  /** Label of the e-mail's single call-to-action button. */
  cta: string;
}
/** A variant (`type#variant`) overrides some fields of its type's template. */
export type NotificationTemplateOverride = Partial<NotificationTemplate>;

/** Plural forms (Intl.PluralRules categories); `{{n}}` is the formatted number. `other` is mandatory. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

export interface LocaleTemplates {
  locale: NotificationLocale;
  dir: 'ltr' | 'rtl';
  /** Luxon formats. */
  formats: { date: string; dateTime: string; time: string };
  /** Joins body parts / list items / a date range. */
  separators: { parts: string; list: string; range: string };
  common: {
    brand: string;
    /** E-mail footer; `{{org}}` is the organisation's display name. */
    footer: string;
    footerPreferences: string;
    footerLocked: string;
    preferencesLink: string;
    linkFallback: string;
    approve: string;
    reject: string;
    oneClickHeading: string;
    /** The one-click links' security copy — part of every e-mail that carries them, never suppressible. */
    oneClickNote: string;
    level: string;
    autoDeductNote: string;
    selfieKind: { in: string; out: string };
    punchKind: { in: string; out: string };
    financeDirection: { pull: string; push: string; sync: string };
    payEffect: { half: string; one: string; other: string };
  };
  plurals: { days: PluralForms; attendanceDays: PluralForms; hours: PluralForms; approvals: PluralForms; balances: PluralForms; punches: PluralForms };
  entities: Record<ApprovalEntity, string>;
  reportTypes: Record<ReportType, string>;
  syncJobTypes: Record<SyncJobType, string>;
  geofenceReasons: Record<string, string>;
  regularisationTypes: Record<string, string>;
  metrics: Record<string, string>;
  /**
   * Flowza Finance connector failure codes (review 8-P2-2: a notice never prints a code where a localised name exists — the same
   * names as Settings → Integrations); an unknown code prints as it is.
   */
  financeErrors: Record<string, string>;
  /** Base templates by notification type and overrides by `type#variant`. */
  templates: Record<string, NotificationTemplate | NotificationTemplateOverride>;
}
