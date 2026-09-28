import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { directionOf } from '@/lib/direction';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';

// the menu is positioned by Radix Popper, which measures its anchor with a ResizeObserver jsdom does not have
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}

async function inLanguage(lng: 'en' | 'ar') {
  await act(async () => { await i18n.changeLanguage(lng); });
}
afterEach(async () => { await inLanguage('en'); });

function ThreeTabs({ dir }: { dir?: 'ltr' | 'rtl' }) {
  return (
    <Tabs defaultValue="notes" dir={dir} data-testid="tabs">
      <TabsList>
        <TabsTrigger value="notes">Notes</TabsTrigger>
        <TabsTrigger value="requests">Requests</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>
      <TabsContent value="notes"><table><tbody><tr><td>row</td></tr></tbody></table></TabsContent>
      <TabsContent value="requests">requests panel</TabsContent>
      <TabsContent value="history">history panel</TabsContent>
    </Tabs>
  );
}

function StatusSelect() {
  return (
    <Select defaultValue="pending">
      <SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="pending">Pending</SelectItem><SelectItem value="approved">Approved</SelectItem></SelectContent>
    </Select>
  );
}

describe('lib/direction', () => {
  it('reads a language tag as right to left for Arabic only', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('ar-OM')).toBe('rtl');
    expect(directionOf('AR')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(directionOf('en-GB')).toBe('ltr');
    expect(directionOf(undefined)).toBe('ltr');
    expect(directionOf('')).toBe('ltr');
  });

  it('is the direction the document itself is given', async () => {
    await inLanguage('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    await inLanguage('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });
});

// Regression (Prompt 11 UI walk): Radix falls back to 'ltr' without a DirectionProvider, and Tabs writes that onto its root, so
// in Arabic every tab panel — the HR reasons table and its row actions, My requests, the HR calendar — ran left to right.
describe('UI kit roots follow the UI language direction', () => {
  it('Tabs: the root (and so every panel inside it) is right to left in Arabic and left to right in English', async () => {
    await inLanguage('ar');
    const { unmount } = render(<ThreeTabs />);
    expect(screen.getByTestId('tabs')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('tablist').closest('[dir]')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('table').closest('[dir]')).toHaveAttribute('dir', 'rtl');
    unmount();
    await inLanguage('en');
    render(<ThreeTabs />);
    expect(screen.getByTestId('tabs')).toHaveAttribute('dir', 'ltr');
  });

  it('Tabs: switching the language re-lays the tabs out without a reload', async () => {
    render(<ThreeTabs />);
    expect(screen.getByTestId('tabs')).toHaveAttribute('dir', 'ltr');
    await inLanguage('ar');
    expect(screen.getByTestId('tabs')).toHaveAttribute('dir', 'rtl');
  });

  it('Tabs: the arrow keys follow the reading order (in Arabic ArrowLeft moves to the next tab, not round to the last)', async () => {
    await inLanguage('ar');
    render(<ThreeTabs />);
    const [first, second] = screen.getAllByRole('tab');
    act(() => { first!.focus(); });
    fireEvent.keyDown(first!, { key: 'ArrowLeft' });
    await waitFor(() => expect(second).toHaveFocus());
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('requests panel')).toBeInTheDocument();
  });

  it("Tabs: a caller's own dir still wins", async () => {
    await inLanguage('ar');
    render(<ThreeTabs dir="ltr" />);
    expect(screen.getByTestId('tabs')).toHaveAttribute('dir', 'ltr');
  });

  it('Select: the trigger is right to left in Arabic (value at the start, chevron at the end)', async () => {
    await inLanguage('ar');
    const { unmount } = render(<StatusSelect />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveAttribute('dir', 'rtl');
    unmount();
    await inLanguage('en');
    render(<StatusSelect />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveAttribute('dir', 'ltr');
  });

  it('DropdownMenu: the open menu is right to left in Arabic', async () => {
    await inLanguage('ar');
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Columns</DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>Name</DropdownMenuItem><DropdownMenuItem>Branch</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Columns' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveAttribute('dir', 'rtl');
  });
});
