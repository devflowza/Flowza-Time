import { useCallback, useRef } from 'react';

/**
 * Keyboard behaviour for a card `role="radiogroup"` (WAI-ARIA APG): exactly one option sits in the tab order and the
 * arrow keys move between the rest. Without it every card is its own tab stop — a grid of ten cards must not be ten
 * tab stops (docs/design.md §6) — and the horizontal keys must follow the reading direction, which is not
 * left-to-right in `ar`. Used by the device wizard's provider grid and the dashboard style gallery.
 */
export function useRovingRadios(count: number, enabledAt: (i: number) => boolean, select: (i: number) => void, rtl: boolean) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const setRef = useCallback((i: number) => (el: HTMLButtonElement | null) => { refs.current[i] = el; }, []);
  const onKeyDown = useCallback((i: number) => (e: React.KeyboardEvent) => {
    const forward = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const back = e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
    if (!forward && !back) return;
    e.preventDefault();
    const dir = forward ? 1 : -1;
    for (let s = 1; s <= count; s++) {
      const j = (((i + dir * s) % count) + count) % count;
      if (enabledAt(j)) { select(j); refs.current[j]?.focus(); return; }
    }
  }, [count, enabledAt, select, rtl]);
  return { setRef, onKeyDown };
}
