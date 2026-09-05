import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/lib/i18n';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/sync.json';
import ar from '@/locales/ar/sync.json';
import { JobProgress, SyncStatusBadge } from './status-badges';

registerNamespace('sync', en, ar);

describe('JobProgress', () => {
  it('sizes the success / failed segments from the item counters', () => {
    render(<JobProgress job={{ itemsTotal: 10, itemsSuccess: 5, itemsFailed: 2, itemsPending: 2, itemsOffline: 1, itemsUnsupported: 0 }} />);
    expect(screen.getByTestId('progress-success')).toHaveStyle({ width: '50%' });
    // failed + offline are both rendered as failures
    expect(screen.getByTestId('progress-failed')).toHaveStyle({ width: '30%' });
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '8');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
    expect(screen.getByText(/5 succeeded/)).toBeInTheDocument();
    expect(screen.getByText(/3 failed/)).toBeInTheDocument();
    expect(screen.getByText(/2 pending/)).toBeInTheDocument();
  });

  it('never divides by zero for an empty job', () => {
    render(<JobProgress job={{ itemsTotal: 0, itemsSuccess: 0, itemsFailed: 0, itemsPending: 0, itemsOffline: 0, itemsUnsupported: 0 }} />);
    expect(screen.getByTestId('progress-success')).toHaveStyle({ width: '0%' });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('renders translated job statuses', () => {
    render(<SyncStatusBadge status="PARTIAL_SUCCESS" />);
    expect(screen.getByText('Partial success')).toBeInTheDocument();
  });
});
