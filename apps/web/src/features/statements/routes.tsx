import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/statements.json';
import ar from '@/locales/ar/statements.json';
import { PageFallback, StatementDetailPage, StatementsPage } from './pages/lazy';

registerNamespace('statements', en, ar);

/**
 * Routes for monthly statements: /statements (HR list + manager inbox) and /statements/:id (document + approval).
 * No RequirePermission wrapper: visibility is per row — statement.view holders see the organisation, a resolved
 * approver sees their pending items, an employee their own — all enforced by the API/RLS, and the emailed
 * manager-notification link must open for approvers who hold no statement.* permission at all.
 * The public review page (/statements/review) is registered in routes.tsx outside the app shell.
 */
export const statementsRoutes: RouteObject[] = [
  { path: 'statements', element: <Suspense fallback={<PageFallback />}><StatementsPage /></Suspense> },
  { path: 'statements/:id', element: <Suspense fallback={<PageFallback />}><StatementDetailPage /></Suspense> },
];
