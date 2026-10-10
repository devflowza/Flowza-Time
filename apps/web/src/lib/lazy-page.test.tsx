import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { lazyPage } from './lazy-page';

const page = (text: string) => ({ default: () => <p>{text}</p> });

function renderInSuspense(node: React.ReactNode) {
  return render(<Suspense fallback={<p>loading</p>}>{node}</Suspense>);
}

describe('lazyPage', () => {
  it('shows the fallback first when the page was never preloaded (the flash preloading removes)', async () => {
    const Page = lazyPage(() => Promise.resolve(page('cold page')));
    renderInSuspense(<Page />);
    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(await screen.findByText('cold page')).toBeInTheDocument();
  });

  it('renders a preloaded page in the same render, without the Suspense fallback', async () => {
    const Page = lazyPage(() => Promise.resolve(page('warm page')));
    await Page.preload();
    renderInSuspense(<Page />);
    expect(screen.getByText('warm page')).toBeInTheDocument();
    expect(screen.queryByText('loading')).not.toBeInTheDocument();
  });

  it('downloads once however often it is asked', async () => {
    const factory = vi.fn(() => Promise.resolve(page('once')));
    const Page = lazyPage(factory);
    const first = Page.preload();
    const second = Page.preload();
    expect(second).toBe(first);
    await first;
    renderInSuspense(<Page />);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed download, so the next attempt fetches again (a stale chunk still reaches the error boundary)', async () => {
    const factory = vi.fn<() => Promise<ReturnType<typeof page>>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce(page('second try'));
    const Page = lazyPage(factory);
    await expect(Page.preload()).rejects.toThrow(/dynamically imported module/);
    await act(async () => { await Page.preload(); });
    renderInSuspense(<Page />);
    expect(screen.getByText('second try')).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
