import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  theme: 'light' | 'dark' | 'system';
  activeOrgId: string | null;
  toggleSidebar: () => void;
  setTheme: (t: UiState['theme']) => void;
  setActiveOrg: (id: string | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: 'system',
      activeOrgId: null,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      setActiveOrg: (activeOrgId) => set({ activeOrgId }),
    }),
    { name: 'flowza.ui' },
  ),
);

export function applyTheme(theme: UiState['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
