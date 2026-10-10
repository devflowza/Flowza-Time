/**
 * The page's scroll container. From `md` up the content sits in a rounded panel that scrolls on its own
 * (components/layout/app-shell.tsx, `#app-scroll`); on a phone the document scrolls, so the browser chrome can collapse.
 */
export const APP_SCROLL_ID = 'app-scroll';

/** Scrolls whichever container is scrolling the page back to the top. */
export function scrollPageToTop(): void {
  const panel = document.getElementById(APP_SCROLL_ID);
  // jsdom implements neither of these; a real browser always has both
  if (panel && typeof panel.scrollTo === 'function') panel.scrollTo({ top: 0 });
  if (typeof window.scrollTo === 'function') {
    try { window.scrollTo({ top: 0 }); } catch { /* jsdom: "Not implemented" */ }
  }
}
