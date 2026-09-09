import { useEffect, useMemo } from 'react';
import { Flame, Layers, Leaf, MoonStar, Sun, Sunset, Waves, type LucideIcon } from 'lucide-react';
import { DASHBOARD_LAYOUTS, DASHBOARD_THEMES, DASHBOARD_TREND_RANGES, type DashboardLayout, type DashboardTheme, type DashboardTrendRange, type OrganizationSettings } from '@flowza/contracts';
import { useActiveMembership } from '@/features/me/use-me';
import { applyDashboardTheme, useUiStore } from '@/stores/ui-store';

/** The tenant's dashboard choices with every default filled in (the settings group is stored partial). */
export interface DashboardSettings {
  theme: DashboardTheme;
  layout: DashboardLayout;
  trendDays: DashboardTrendRange;
  showGreeting: boolean;
  showQuote: boolean;
  showHighlight: boolean;
}
export const DASHBOARD_DEFAULTS: DashboardSettings = { theme: 'emerald', layout: 'overview', trendDays: 14, showGreeting: true, showQuote: true, showHighlight: true };

/** Gallery order and icon per style; names and blurbs live in the `settings` namespace (`dashboard.themes.<key>`). */
export const DASHBOARD_THEME_META: ReadonlyArray<{ key: DashboardTheme; icon: LucideIcon }> = [
  { key: 'emerald', icon: Leaf },
  { key: 'midnight', icon: MoonStar },
  { key: 'classic', icon: Sun },
  { key: 'desert', icon: Sunset },
  { key: 'ocean', icon: Waves },
  { key: 'graphite', icon: Layers },
  { key: 'crimson', icon: Flame },
];

const isTheme = (v: unknown): v is DashboardTheme => typeof v === 'string' && (DASHBOARD_THEMES as readonly string[]).includes(v);
const isLayout = (v: unknown): v is DashboardLayout => typeof v === 'string' && (DASHBOARD_LAYOUTS as readonly string[]).includes(v);
const isRange = (v: unknown): v is DashboardTrendRange => typeof v === 'number' && (DASHBOARD_TREND_RANGES as readonly number[]).includes(v);

/**
 * Tolerant on purpose: /me is parsed by the API, but a style removed from the catalogue in a later release (or a
 * stale bundle) must fall back to the default look rather than an unstyled shell.
 */
export function resolveDashboardSettings(raw: Partial<OrganizationSettings['dashboard']> | null | undefined): DashboardSettings {
  return {
    theme: isTheme(raw?.theme) ? raw.theme : DASHBOARD_DEFAULTS.theme,
    layout: isLayout(raw?.layout) ? raw.layout : DASHBOARD_DEFAULTS.layout,
    trendDays: isRange(raw?.trendDays) ? raw.trendDays : DASHBOARD_DEFAULTS.trendDays,
    showGreeting: raw?.showGreeting ?? DASHBOARD_DEFAULTS.showGreeting,
    showQuote: raw?.showQuote ?? DASHBOARD_DEFAULTS.showQuote,
    showHighlight: raw?.showHighlight ?? DASHBOARD_DEFAULTS.showHighlight,
  };
}

/** The active organisation's dashboard settings, defaults applied. */
export function useDashboardSettings(): DashboardSettings {
  const raw = useActiveMembership()?.settings.dashboard;
  return useMemo(() => resolveDashboardSettings(raw), [raw]);
}

/**
 * Keeps `<html data-theme>` in step with the organisation's style — or with the style an administrator is trying out in
 * Settings → Dashboard, which wins until it is saved or abandoned. Cleared when the shell unmounts (sign-out), so the
 * auth screens never wear the last tenant's colours.
 */
export function useApplyDashboardTheme(): void {
  const orgTheme = useDashboardSettings().theme;
  const preview = useUiStore((s) => s.previewDashboardTheme);
  useEffect(() => { applyDashboardTheme(preview ?? orgTheme); }, [preview, orgTheme]);
  useEffect(() => () => applyDashboardTheme(null), []);
}
