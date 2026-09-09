import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DashboardTheme } from '@flowza/contracts';

interface UiState {
  sidebarCollapsed: boolean;
  theme: 'light' | 'dark' | 'system';
  activeOrgId: string | null;
  /**
   * A dashboard style being tried out in Settings → Dashboard before it is saved. Session-only on purpose: the saved
   * choice lives in the organisation's settings and reaches every member through /me, so nothing here may outlive a
   * page load and make one browser look different from the tenant's decision.
   */
  previewDashboardTheme: DashboardTheme | null;
  toggleSidebar: () => void;
  setTheme: (t: UiState['theme']) => void;
  setActiveOrg: (id: string | null) => void;
  setPreviewDashboardTheme: (t: DashboardTheme | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: 'system',
      activeOrgId: null,
      previewDashboardTheme: null,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      setActiveOrg: (activeOrgId) => set({ activeOrgId }),
      setPreviewDashboardTheme: (previewDashboardTheme) => set({ previewDashboardTheme }),
    }),
    { name: 'flowza.ui', partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, theme: s.theme, activeOrgId: s.activeOrgId }) },
  ),
);

export function applyTheme(theme: UiState['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** The tenant's dashboard style is a `data-theme` on <html>; the variable blocks in globals.css do the rest. */
export function applyDashboardTheme(theme: DashboardTheme | null) {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}
