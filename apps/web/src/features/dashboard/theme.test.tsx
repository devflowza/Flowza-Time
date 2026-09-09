import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DASHBOARD_THEMES } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);

import { testState } from '@/features/employees/test-mocks';
import { useUiStore } from '@/stores/ui-store';
import { DASHBOARD_THEME_META, resolveDashboardSettings, useApplyDashboardTheme } from './theme';

function Shell() { useApplyDashboardTheme(); return null; }

describe('dashboard theme', () => {
  beforeEach(() => { testState.orgId = 'org-1'; testState.settings = {}; useUiStore.getState().setPreviewDashboardTheme(null); document.documentElement.removeAttribute('data-theme'); });

  it('puts the organisation\'s style on <html>, lets a preview win, and clears it when the shell unmounts', () => {
    testState.settings = { dashboard: { theme: 'crimson' } };
    const { unmount } = render(<Shell />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('crimson');
    act(() => useUiStore.getState().setPreviewDashboardTheme('ocean'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('ocean');
    act(() => useUiStore.getState().setPreviewDashboardTheme(null));
    expect(document.documentElement.getAttribute('data-theme')).toBe('crimson');
    unmount();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('falls back to the defaults for anything it does not recognise', () => {
    expect(resolveDashboardSettings(undefined)).toEqual({ theme: 'emerald', layout: 'overview', trendDays: 14, showGreeting: true, showQuote: true, showHighlight: true });
    expect(resolveDashboardSettings({ theme: 'neon' as never, layout: 'kanban' as never, trendDays: 9 as never, showQuote: false })).toEqual({ theme: 'emerald', layout: 'overview', trendDays: 14, showGreeting: true, showQuote: false, showHighlight: true });
    expect(resolveDashboardSettings({ theme: 'desert', layout: 'operations', trendDays: 30 })).toMatchObject({ theme: 'desert', layout: 'operations', trendDays: 30 });
  });

  it('every style in the catalogue has a CSS block with the same tokens as the default style, in both modes', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
    const tokensOf = (selector: string): Set<string> => {
      const start = css.indexOf(selector);
      expect(start, `missing block ${selector}`).toBeGreaterThan(-1);
      const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
      return new Set([...body.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    };
    const reference = tokensOf("[data-theme='emerald']");
    expect(reference.size).toBeGreaterThan(20);
    expect(DASHBOARD_THEME_META.map((m) => m.key)).toEqual([...DASHBOARD_THEMES]);
    for (const theme of DASHBOARD_THEMES) {
      const light = tokensOf(`[data-theme='${theme}']`);
      expect([...reference].filter((t) => !light.has(t)), `${theme} lacks tokens`).toEqual([]);
      // the dark variant covers at least the mode-dependent accent, and any light sidebar
      const dark = tokensOf(`.dark[data-theme='${theme}']`);
      expect(dark.has('accent'), `${theme} has no dark accent`).toBe(true);
    }
    // a white sidebar must turn dark with the mode, or the sidebar text vanishes
    expect(tokensOf(".dark[data-theme='classic']").has('sidebar')).toBe(true);
  });
});
