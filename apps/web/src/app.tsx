import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { AuthProvider } from '@/features/auth/auth-provider';
import { TooltipProvider } from '@/components/ui';
import { applyTheme, useUiStore } from '@/stores/ui-store';
import { router } from '@/routes';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});

export function App() {
  const theme = useUiStore((s) => s.theme);
  const { i18n } = useTranslation();
  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(theme);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          <Toaster position={i18n.dir() === 'rtl' ? 'bottom-left' : 'bottom-right'} richColors closeButton dir={i18n.dir()} />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
