import '@testing-library/jest-dom/vitest';

// nwsapi 2.2.27 (bundled with jsdom 26) answers `:fullscreen`, `:modal`, `:popover-open` and `:picture-in-picture` by calling
// element.matches() again, which recurses through jsdom (tens of millions of calls, ~30 s per Radix Select open). Nothing in
// these tests is fullscreen, a native modal <dialog> or a popover, so those state pseudo-classes are answered directly.
const nativeMatches = Element.prototype.matches;
const STATE_PSEUDO_CLASSES = /^:(fullscreen|modal|popover-open|picture-in-picture)$/;
Element.prototype.matches = function matches(this: Element, selectors: string): boolean {
  if (STATE_PSEUDO_CLASSES.test(selectors)) return false;
  return nativeMatches.call(this, selectors);
};
