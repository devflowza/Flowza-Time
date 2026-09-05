import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import { EffectiveChangeDialog } from './effective-change-dialog';

describe('EffectiveChangeDialog', () => {
  it('blocks dates before the current history row and submits date + reason', () => {
    const onConfirm = vi.fn();
    renderWithProviders(<EffectiveChangeDialog open onOpenChange={() => {}} changedFields={['branchId']} defaultDate="2023-12-31" minDate="2024-01-01" onConfirm={onConfirm} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Branch')).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply change' });
    expect(apply).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('2024-01-01');
    fireEvent.change(screen.getByLabelText(/Effective from/), { target: { value: '2024-03-01' } });
    expect(apply).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  Transfer ' } });
    fireEvent.click(apply);
    expect(onConfirm).toHaveBeenCalledWith({ effectiveFrom: '2024-03-01', changeReason: 'Transfer' });
  });
});
