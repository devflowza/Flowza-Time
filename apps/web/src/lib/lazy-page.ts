import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same constraint React.lazy itself uses
type AnyComponent = ComponentType<any>;
type Module<T extends AnyComponent> = { default: T };

export type PreloadableComponent<T extends AnyComponent> = LazyExoticComponent<T> & {
  /** Starts downloading the page's chunk; resolves once it is in memory. Safe to call any number of times. */
  preload: () => Promise<Module<T>>;
};

/**
 * `React.lazy` for a route's page, with a `preload()` the shell calls when a link is hovered or focused, and on idle for
 * the pages in the sidebar (lib/route-preload.ts).
 *
 * Preloading alone does not stop the flash: `lazy` calls `.then` on whatever the factory returns, and a native promise
 * runs that callback a microtask later, so the first render still suspends and the route's Suspense boundary — new on
 * every navigation — shows its skeleton for a frame before the page. Once the module is in memory the factory hands
 * back a thenable that settles synchronously instead, so `lazy` resolves inside the render and the page appears at once.
 *
 * A failed download is forgotten, so the next attempt (a render, or the next hover) fetches again and a stale chunk
 * after a deploy still reaches the route's error boundary (lib/stale-chunk.ts).
 */
export function lazyPage<T extends AnyComponent>(factory: () => Promise<Module<T>>): PreloadableComponent<T> {
  let loaded: Module<T> | undefined;
  let pending: Promise<Module<T>> | undefined;
  const load = (): Promise<Module<T>> => {
    pending ??= factory().then(
      (module) => { loaded = module; return module; },
      (error: unknown) => { pending = undefined; throw error; },
    );
    return pending;
  };
  const Page = lazy(() => (loaded ? (settled(loaded) as Promise<Module<T>>) : load()));
  return Object.assign(Page, { preload: load });
}

/** A thenable that calls its fulfilment handler synchronously. React writes `status`/`value` onto it, so it is a plain object. */
function settled<T>(value: T): PromiseLike<T> {
  return {
    then<R1 = T, R2 = never>(onFulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null): PromiseLike<R1 | R2> {
      return settled(onFulfilled ? (onFulfilled(value) as R1) : (value as unknown as R1));
    },
  };
}

export function isPreloadable(type: unknown): type is { preload: () => Promise<unknown> } {
  return (typeof type === 'object' || typeof type === 'function') && type !== null && typeof (type as { preload?: unknown }).preload === 'function';
}
