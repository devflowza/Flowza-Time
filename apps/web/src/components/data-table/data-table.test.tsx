import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import i18n from '@/lib/i18n';
import { DataTable } from './data-table';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}

interface Row { id: string; name: string; branch: string }
const rows: Row[] = [{ id: 'r1', name: 'Maryam', branch: 'Muscat HQ' }, { id: 'r2', name: 'Omar', branch: 'Sohar' }];
const columns: ColumnDef<Row, unknown>[] = [
  { id: 'name', accessorKey: 'name', header: 'Name' },
  { id: 'branchName', accessorKey: 'branch', header: 'Branch' },
  // a drawn heading and an unlabelled actions column: nothing a person could recognise them by in the chooser
  { id: 'avatarBadge', header: () => <span aria-hidden>●</span>, cell: () => null },
  { id: 'actions', header: '', cell: () => <button type="button">Open</button> },
];

let tableSeq = 0;
function Table({ selectable = false, storageKey = `test-${++tableSeq}` }: { selectable?: boolean; storageKey?: string }) {
  return (
    <DataTable columns={columns} data={rows} total={2} page={1} pageSize={25} onPageChange={() => {}} onPageSizeChange={() => {}} storageKey={storageKey}
      getRowId={(r) => r.id} {...(selectable ? { selection: {}, onSelectionChange: () => {} } : {})} />
  );
}

async function inLanguage(lng: 'en' | 'ar') {
  await act(async () => { await i18n.changeLanguage(lng); });
}
afterEach(async () => { await inLanguage('en'); });

// Regression (Prompt 11 UI walk): the shared table's column chooser read "Columns" in every language, listed the actions
// column as a blank entry and a drawn heading by its raw id, and the selection boxes were announced in English.
describe('DataTable — column chooser and selection labels', () => {
  it('names the column chooser in the UI language and lists only columns with a written heading', async () => {
    await inLanguage('ar');
    render(<Table />);
    const chooser = screen.getByRole('button', { name: 'الأعمدة' });
    expect(chooser).toHaveTextContent('الأعمدة');
    fireEvent.keyDown(chooser, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('الأعمدة')).toBeInTheDocument();
    expect(within(menu).getAllByRole('menuitemcheckbox').map((i) => i.textContent)).toEqual(['Name', 'Branch']);
    expect(within(menu).queryByText('avatarBadge')).toBeNull();
    expect(menu).toHaveAttribute('dir', 'rtl');
  });

  it('keeps the English names in English (no change for the tests and pages that read them)', async () => {
    render(<Table selectable />);
    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: 'Select row' })).toHaveLength(2);
  });

  it('announces the selection boxes in Arabic', async () => {
    await inLanguage('ar');
    render(<Table selectable />);
    expect(screen.getByRole('checkbox', { name: 'تحديد الكل' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: 'تحديد الصف' })).toHaveLength(2);
  });
});
