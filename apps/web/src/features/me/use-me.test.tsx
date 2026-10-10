import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const cached = { userId: 'u-1', at: Date.now(), data: { user: { id: 'u-1' }, memberships: [] } };
vi.mock('./me-cache', () => ({ readCachedMe: vi.fn(() => cached), writeCachedMe: vi.fn() }));
// the request never answers: the test is about what happens before it does
vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn(() => new Promise(() => {})) } }));

import { readCachedMe } from './me-cache';
import { useMe } from './use-me';

function Reader({ n }: { n: number }) {
  const me = useMe();
  return <p data-n={n}>{me.data?.user.id}</p>;
}

describe('useMe', () => {
  it('reads the stored /me once, when the query is built — not on every render of every reader', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (n: number) => <QueryClientProvider client={client}>{Array.from({ length: 20 }, (_, i) => <Reader key={i} n={n} />)}</QueryClientProvider>;
    const { rerender, container } = render(tree(0));
    for (let n = 1; n <= 5; n++) rerender(tree(n));
    // the cached copy reached every reader…
    expect(container.querySelectorAll('p')[19]?.textContent).toBe('u-1');
    // …for the price of one read for the data and one for its age, instead of one per reader per render (here 120)
    expect(vi.mocked(readCachedMe).mock.calls.length).toBeLessThanOrEqual(2);
  });
});
