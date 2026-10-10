import { Suspense, type ReactNode } from 'react';
import type { RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyPage } from './lazy-page';
import { preloadRoute, registerPreloadRoutes, resetRoutePreloadForTests } from './route-preload';

/** A page whose download is observable, shaped like every feature's lazy page. */
function trackedPage() {
  const factory = vi.fn(() => Promise.resolve({ default: () => null }));
  return { Page: lazyPage(factory), factory };
}
const Guard = ({ children }: { children: ReactNode }) => <>{children}</>;

describe('preloadRoute', () => {
  afterEach(() => resetRoutePreloadForTests());

  it('finds the lazy page under the guard and Suspense wrappers of the route that matches, and only that one', async () => {
    const list = trackedPage();
    const detail = trackedPage();
    const routes: RouteObject[] = [{
      path: '/',
      children: [
        { path: 'employees', element: <Guard><Suspense fallback={null}><list.Page /></Suspense></Guard> },
        { path: 'employees/:id', element: <Guard><Suspense fallback={null}><detail.Page /></Suspense></Guard> },
      ],
    }];
    registerPreloadRoutes(routes);

    preloadRoute('/employees/42?tab=history');
    await Promise.resolve();
    expect(detail.factory).toHaveBeenCalledTimes(1);
    expect(list.factory).not.toHaveBeenCalled();
  });

  it('asks each destination once, and does nothing for a path no route serves', () => {
    const page = trackedPage();
    registerPreloadRoutes([{ path: '/reports', element: <Suspense fallback={null}><page.Page /></Suspense> }]);
    preloadRoute('/reports');
    preloadRoute('/reports');
    preloadRoute('/nowhere');
    expect(page.factory).toHaveBeenCalledTimes(1);
  });

  it('follows a guard component that carries its page\'s preload (pages rendered inside a route guard)', () => {
    const page = trackedPage();
    function NotesRoute() { return <page.Page />; }
    NotesRoute.preload = page.Page.preload;
    registerPreloadRoutes([{ path: '/attendance/notes', element: <NotesRoute /> }]);
    preloadRoute('/attendance/notes');
    expect(page.factory).toHaveBeenCalledTimes(1);
  });

  it('is a no-op before the router has registered its routes', () => {
    expect(() => preloadRoute('/employees')).not.toThrow();
  });
});
