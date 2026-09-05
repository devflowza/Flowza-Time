import type { RouteObject } from 'react-router';

/**
 * Feature route registrations. Each feature exports its RouteObject[] from features/<name>/routes.tsx and is spread here.
 * Keep pages lazy-loaded (React.lazy) so the initial bundle stays small.
 */
export const featureRoutes: RouteObject[] = [];
