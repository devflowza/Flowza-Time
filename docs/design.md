# Design system

How the web app is built visually, and the rules a screen has to satisfy before it ships. Tokens live in
`apps/web/src/styles/globals.css`; primitives in `apps/web/src/components/ui/`; layout in
`apps/web/src/components/layout/`.

This is a working document, not an aspiration: every rule below is enforced somewhere in the codebase, and the
walkthroughs in §8 record the screens that have been brought up to it.

---

## 1. Tokens

Never hard-code a colour, radius or shadow. Everything routes through `@theme` in `globals.css`, which maps semantic
names onto CSS variables that `:root` and `.dark` redefine.

| Token | Use |
|---|---|
| `bg-background` / `text-foreground` | Page ground and default text |
| `bg-card` / `text-card-foreground` | Any raised surface |
| `bg-muted` / `text-muted-foreground` | Recessed panels; secondary and helper text |
| `border-border`, `border-input` | Hairlines; form control outlines |
| `brand-50 … brand-900` | The product's green. `brand-600/700` for action, `brand-500` for selection and focus |
| `text-primary`, `bg-primary` | Primary action; already resolves to `brand-700` |
| `destructive`, `success`, `warning`, `info` | Status only — never decoration |
| `ring-ring` | Focus ring; equals `brand-500` |
| `shadow-card` | The only elevation. Two shadows, both tiny. There is no `shadow-lg` tier |
| `radius-sm/md/lg/xl` | 6 / 8 / 12 / 16px. Cards and panels are `rounded-lg` |

Dark mode is a class on `<html>`, not a media query, so it can be toggled. Any colour written outside the token set
must define both halves inline (`bg-blue-50/60 dark:bg-blue-950/30`) or it will be unreadable in one of them.

**Type.** Inter for Latin, IBM Plex Sans Arabic for Arabic, JetBrains Mono for codes, serials and configuration keys.
Anything numeric that lines up in a column gets `.tnum` (tabular figures): attendance totals, step numbers, counts.

## 2. Right-to-left is not a theme

The app ships `en` and `ar`, and `ar` runs the whole layout in RTL. This is a hard constraint on every class you write.

- **Use logical properties, always.** `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `text-start`/`text-end`. Never `ml-`,
  `pr-`, `left-`, `text-left`. A physical utility is a bug that only shows up in Arabic.
- **Mirror directional icons**, and only those: `<ArrowLeft className="rtl:rotate-180" />`. A clock or a plug does not
  mirror.
- **Keep LTR islands LTR.** Machine-shaped values — device codes, serial numbers, IANA timezones, URLs, IP addresses —
  get `dir="ltr"` so they do not reorder inside Arabic text.
- **Arrow keys follow the reading direction.** In a horizontal composite widget, <kbd>→</kbd> means "next" in `en` and
  "previous" in `ar`. Read the direction from `i18n.dir()`, not from the layout.

## 3. Page skeleton

```
page-container (max-w-[1600px], responsive padding)
└── PageHeader        title · optional description · optional breadcrumbs · actions on the end side
└── content
```

Override the container width when the content wants it: `page-container max-w-7xl` for a wizard, the default for a
data table that should use the whole screen. Choosing a width is a decision — see §4.

Every page owns exactly one `<h1>`, and that is `PageHeader`'s. Sections below it start at `<h2>`.

## 4. Density and the use of space

The two failure modes are equally bad, and both were real in this codebase:

1. **Stranded width.** A narrow column centred in a wide viewport, with a grid inside it that never fills. The Register
   device page put 490px cards in a 1665px content area — 71% of the horizontal space unused — because its grid was
   subdivided by vendor and each vendor had one entry.
2. **Wall-to-wall text.** Prose or form labels stretched across 1600px, which nobody can read.

Rules:

- **Cap by content, not by habit.** Reading text: `max-w-prose`. A form: enough for two or three columns of fields, no
  more. A table or a dashboard: the full container.
- **A grid must be able to fill.** Before writing `sm:grid-cols-2 xl:grid-cols-3`, check that the collection actually
  reaches the container un-subdivided. Grouping headers inside a grid usually defeat it; make the group a property of
  the card (an eyebrow line, a filter chip) instead of a wrapper around its own grid.
- **Use the width for something.** On `lg` and up, a wizard or a detail page can put navigation, progress or a summary
  in a side rail rather than stacking it above the content and leaving the margin empty.
- **Multi-column forms are allowed** for short, independent, individually-labelled fields — `sm:grid-cols-2
  xl:grid-cols-3`, long fields spanning. A single column stays the default for anything filled in sequence, or where
  one answer changes the next.
- **Vertical rhythm:** `space-y-4` inside a panel, `gap-6` between panels, `p-5` for card padding, `gap-3` between
  cards in a grid.

Rough targets, not laws: a step of a wizard should fit in about one and a half screens at 1080p; a list page's first
row should be visible without scrolling.

## 5. Components

**Card** is the only surface. `rounded-lg border bg-card shadow-card`. Do not nest a card in a card — use
`rounded-lg border bg-muted/40 p-4` for a panel inside one.

**Button.** `default` for the one primary action on the screen, `outline` for secondary, `ghost` for tertiary and for
anything in a toolbar, `destructive` only for real destruction. `loading` disables and shows a spinner; it cannot be
combined with `asChild` (Radix `Slot` takes exactly one child).

> `asChild` merges `className` by string concatenation. Passing a *function* className through it — as `NavLink`'s
> `({ isActive }) => …` — stringifies the function into the class attribute and silently destroys the layout. Use
> `aria-current` and a plain string instead. This shipped once; see `sidebar.test.tsx`.

**Badge** carries status, never decoration. Tone maps to meaning: `success` online, `danger` offline/error, `warning`
degraded, `info` informational, `neutral`/`outline` unknown. Badges are `<span>`s, so they may appear inside a button.

**FormField** wraps every control: label, required/optional marker, and one of hint *or* error. Errors get
`role="alert"`; controls get `aria-invalid`.

**Empty, loading, error** are three distinct states and each needs its own treatment. Loading is a `Skeleton` shaped
like the content it replaces — same grid, same card height — never a spinner in the middle of a blank page.
`ErrorState` always offers a retry. `EmptyState` says what to do next.

## 6. Accessibility floor

Non-negotiable, checked in review:

- **Semantics first.** A thing that navigates is a link; a thing that acts is a button. Never an `onClick` on a `div`.
- **No nested interactives.** An `<a>` inside a `<button>` is invalid HTML, unreachable by keyboard, and ambiguous to a
  screen reader. If a card is a control, its links move outside it.
- **Phrasing content only inside a `<button>`.** No `<div>`, no `<p>`. Use `<span class="block">`. This is why
  `CapabilityChips` renders a `<span>`.
- **Composite widgets follow the WAI-ARIA APG.** A `role="radiogroup"` of cards is *one* tab stop: the selected option
  carries `tabIndex=0`, the rest `-1`, and the arrow keys move focus and selection (skipping disabled options, honouring
  reading direction). A grid of ten cards must not be ten tab stops.
- **Focus is always visible** — `:focus-visible` gives a 2px `ring-ring` with an offset globally. Never remove it.
- **Announce content that swaps without a route change.** A wizard step, a tab panel: move focus to the new heading
  (`tabIndex={-1}` + `.focus()`), but never on first render, where it steals focus from the page.
- **Target size** ≥ 24px for a control, ≥ 36px for anything in a primary flow.
- **Contrast** ≥ 4.5:1 for text. `text-muted-foreground` on `bg-muted` is the tightest pair in the system and passes;
  do not invent a lighter grey.
- **Reduced motion** is honoured globally in `globals.css`. Do not add an animation that ignores it.

## 7. Multi-step flows

The Register device wizard is the reference implementation
(`apps/web/src/features/devices/pages/device-new-page.tsx`).

- **One decision per step, and no step that holds a single control.** If a step can only be answered one way, or its
  question is really a clause of the previous one, merge it. Register device went 6 steps → 4 by folding *model* into
  *provider* (one decision: "what am I connecting?") and *test* into *connection* (the test tests the settings directly
  above it).
- **Progress lives in a rail on `lg`+, a bar below it.** The rail shows each step's captured answer, so earlier choices
  stay visible, and doubles as a back link to any completed step.
- **State belongs to the wizard, not to the step.** A step component that owns its form throws the answers away when
  the user presses Back. Hoist the form; reset it only when an earlier answer invalidates it.
- **Validate on every exit from a step, not just on Next.** Once a step's answer is a snapshot that later steps read,
  any route out of it that skips the resolver — Back, a rail link, an Edit button on the review screen — can leave the
  snapshot describing something the user has since changed. Forward is refused while the step is invalid; backward
  drops the snapshot and rewinds the progress that depended on it.
- **The primary action is always reachable** — the step's Back/Next bar is `sticky bottom-0` inside the panel.
- **Review is editable in place.** Each group on the final step has its own Edit that jumps to the step that owns it.
- **Never gate forward movement silently.** A disabled Next is paired with a hint saying what is missing.

## 8. Applied — Register device

Recorded because it is the worked example the rules above were written against.

| | Before | After |
|---|---|---|
| Steps | 6 | 4 |
| Page height, first step @1920×953 | 2051px (2.2 screens) | ~1 screen |
| Provider cards per row @1665px content | 1 of 3 possible | 3 |
| Tab stops to cross the provider grid | 4 | 1 |
| Nav clicks to reach Review | 5 | 3 |
| Answers kept when pressing Back | no | yes |
| Rail/Edit can carry a stale answer to Review | — | no (revalidated on exit) |

What changed, and why each was wrong before:

- **One grid for all providers.** Each vendor had its own `<section>` with its own grid, and each vendor ships exactly
  one integration, so `sm:grid-cols-2 xl:grid-cols-3` rendered as four one-column rows. Vendor is now an eyebrow line
  inside the card. (§4)
- **`max-w-7xl` with a `15rem` rail.** The wizard was `max-w-5xl` centred in a 1665px area with the stepper stacked
  above it. (§4)
- **Denser cards** — two-line description clamp, capabilities capped at four with a `+n`, selection shown by a check in
  the corner. (§4)
- **Docs link moved out of the card.** It was an `<a>` inside `<button role="radio">`. (§6)
- **Roving tabindex and arrow keys on both radiogroups**, RTL-aware, skipping unimplemented providers. (§6)
- **Models as rows, not cards.** The choice is skippable, so it does not deserve the weight of the provider decision.
- **A search box appears at seven providers.** Below that it is noise; above it a flat grid stops being scannable.
- **Focus moves to the step heading** on every step change but the first. (§6)
- **Sticky action bar**; Next carries "Choose a provider to continue" while disabled, at every screen size. (§7)
- **Every exit from the details step revalidates.** The rail and the review screen's Edit made it possible to change a
  field and then leave without re-submitting, so Review — and the create call — used the previous snapshot. (§7)

Regression tests: `apps/web/src/features/devices/pages/device-new-page.test.tsx`. Each one was confirmed to fail
against the pre-redesign component before the fix landed.

## 9. Checklist before shipping a screen

- [ ] No physical direction utilities; checked at `dir="rtl"`
- [ ] Light and dark both legible; no untokenised colour without a `dark:` pair
- [ ] Keyboard-only pass: every control reachable, focus visible, composite widgets are one tab stop
- [ ] Loading state is a skeleton shaped like the content; error state offers retry; empty state says what to do next
- [ ] The layout fills its container at 1920px and survives 360px
- [ ] Every string comes from `t()` and exists in both `en` and `ar`
- [ ] A regression test that fails against the previous behaviour
