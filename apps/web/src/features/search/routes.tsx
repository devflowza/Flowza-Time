import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/search.json';
import ar from '@/locales/ar/search.json';
import { PageFallback, SearchPage } from './pages/lazy';

registerNamespace('search', en, ar);

/** Routes for the search feature: /search?q= (any member; results are permission-filtered by the API). */
export const searchRoutes: RouteObject[] = [
  { path: 'search', element: <Suspense fallback={<PageFallback />}><SearchPage /></Suspense> },
];
