import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazy } from 'react';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';
import '@/lib/i18n';
import type * as StaleChunk from '@/lib/stale-chunk';

const h = vi.hoisted(() => ({ reload: vi.fn() }));

vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
// jsdom cannot navigate: observe the reload instead of performing it
vi.mock('@/lib/stale-chunk', async (importOriginal) => {
  const actual = await importOriginal<typeof StaleChunk>();
  return { ...actual, reloadForStaleChunk: (now?: number) => actual.reloadForStaleChunk(now, h.reload) };
});

import { STALE_CHUNK_RELOAD_KEY, resetStaleChunkReloadForTests } from '@/lib/stale-chunk';
import { RouteError } from './route-error';

const staleChunk = () => new TypeError('Failed to fetch dynamically imported module: https://time.flowza.ai/assets/employee-new-page-BIvQk39w.js');

/** The shape routes.tsx uses: a shell layout whose pages sit under a pathless route carrying the boundary. */
function renderAt(page: RouteObject['element']) {
  const router = createMemoryRouter([{
    errorElement: <RouteError fullScreen />,
    children: [{
      element: <div><nav>Shell sidebar</nav><Outlet /></div>,
      children: [{ errorElement: <RouteError />, children: [{ path: '/employees/new', element: page }] }],
    }],
  }], { initialEntries: ['/employees/new'] });
  return render(<RouterProvider router={router} />);
}

describe('RouteError', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetStaleChunkReloadForTests();
    h.reload.mockReset();
    // React and React Router both report the caught render error; the assertions below are about what the user sees
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reloads by itself when a deploy replaced the page chunk, inside the shell instead of the developer screen', async () => {
    const Page = lazy(() => Promise.reject(staleChunk()));
    renderAt(<Page />);
    expect(await screen.findByRole('status')).toHaveTextContent('FlowZa Time has been updated');
    expect(screen.getByRole('status')).toHaveTextContent('Loading the latest version…');
    expect(screen.getByText('Shell sidebar')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/unexpected application error|hey developer/i);
    expect(h.reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY)).not.toBeNull();
  });

  it('offers a reload button instead of looping when the automatic reload just happened', async () => {
    sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(Date.now()));
    const Page = lazy(() => Promise.reject(staleChunk()));
    renderAt(<Page />);
    expect(await screen.findByRole('status')).toHaveTextContent('Reload the page to continue with the latest version.');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('shows any other render failure as an error with a way out, and does not reload', async () => {
    function Broken(): never { throw new Error('boom'); }
    renderAt(<Broken />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute('href', '/');
    expect(screen.getByText('Shell sidebar')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('boom');
    expect(h.reload).not.toHaveBeenCalled();
  });
});
