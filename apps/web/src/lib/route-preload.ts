import { isValidElement, type ReactNode } from 'react';
import { matchRoutes, type RouteObject } from 'react-router';
import { isPreloadable } from './lazy-page';

/**
 * Downloads a route's page chunk before the user goes there, so the navigation itself has nothing to wait for.
 *
 * The router registers its route tree once (routes.tsx) — importing it here would be circular, since the shell that
 * calls `preloadRoute` is part of that tree. A route's lazy pages are found by walking its `element` (every feature wraps
 * its page as `<RequirePermission><Suspense>{page}</Suspense></RequirePermission>`) for components made by `lazyPage`.
 */
let routes: RouteObject[] = [];
const done = new Set<string>();

export function registerPreloadRoutes(tree: RouteObject[]): void {
  routes = tree;
  done.clear();
}

function collect(node: ReactNode, out: Set<{ preload: () => Promise<unknown> }>, depth: number): void {
  if (depth > 12 || node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) { for (const child of node as ReactNode[]) collect(child, out, depth + 1); return; }
  if (!isValidElement(node)) return;
  if (isPreloadable(node.type)) out.add(node.type);
  collect((node.props as { children?: ReactNode }).children, out, depth + 1);
}

/** Starts loading every lazy page on the way to `path` (a pathname, optionally with a query). Never throws. */
export function preloadRoute(path: string): void {
  const pathname = path.split(/[?#]/)[0] || '/';
  if (done.has(pathname) || routes.length === 0) return;
  done.add(pathname);
  const found = new Set<{ preload: () => Promise<unknown> }>();
  for (const match of matchRoutes(routes, pathname) ?? []) collect(match.route.element, found, 0);
  for (const page of found) {
    // a failure is retried by the render itself (and reaches the route's error boundary there); forget it here
    page.preload().catch(() => done.delete(pathname));
  }
}

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
type SlowNavigator = Navigator & { connection?: { saveData?: boolean; effectiveType?: string } };

/**
 * Preloads the given destinations one at a time while the browser is idle, after the current page has settled. Skipped
 * when the user asked to save data or the connection is slow — hover and focus still preload one page at a time there.
 */
export function preloadRoutesWhenIdle(paths: string[]): () => void {
  const connection = (navigator as SlowNavigator).connection;
  if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return () => {};
  const queue = paths.filter((p) => !done.has(p.split(/[?#]/)[0] || '/'));
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const w = window as IdleWindow;
  const idle = (cb: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(cb, { timeout: 4_000 }) : setTimeout(cb, 200));
  const next = () => {
    if (cancelled) return;
    const path = queue.shift();
    if (!path) return;
    preloadRoute(path);
    timer = setTimeout(() => idle(next), 120);
  };
  // let the page that is opening fetch its own data first
  timer = setTimeout(() => idle(next), 1_500);
  return () => { cancelled = true; if (timer) clearTimeout(timer); };
}

/** Test seam. */
export function resetRoutePreloadForTests(): void {
  routes = [];
  done.clear();
}
