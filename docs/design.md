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
| `bg-popover` / `text-popover-foreground` | Floating layers: menus, selects, popovers (a step above the card in dark mode) |
| `bg-muted` / `text-muted-foreground` | Recessed panels; secondary and helper text |
| `bg-muted-strong` | Hover on a muted surface, skeletons, the active tab in dark mode |
| `border-border`, `border-input` | Hairlines; form control outlines (`input` is a shade darker) |
| `brand-50 … brand-900` | The product's green. `brand-600/700` for action, `brand-500` for selection and focus |
| `text-primary`, `bg-primary` | Primary action; already resolves to `brand-700` |
| `destructive`, `success`, `warning`, `info` | Status only — never decoration |
| `ring-ring` | Focus ring; equals `brand-500` |
| `shadow-xs` · `shadow-sm` · `shadow-card` | Resting elevation: controls, small chips, cards. Tinted with the ink colour, never pure black |
| `shadow-md` · `shadow-lg` | Floating elevation: menus/selects/tooltips (`md`), dialogs and sheets (`lg`). In dark mode depth comes from a lighter surface, a hairline and a top highlight instead |
| `radius-sm/md/lg/xl/2xl` | 6 / 8 / 12 / 14 / 18px. Controls `rounded-md`, small tiles `rounded-lg`, cards and table panels `rounded-xl`, dialogs and the content panel `rounded-2xl` |
| `ease-out` · `ease-spring` · `animate-*` | Motion tokens (§12) |

Dark mode is a class on `<html>`, not a media query, so it can be toggled. Any colour written outside the token set
must define both halves inline (`bg-blue-50/60 dark:bg-blue-950/30`) or it will be unreadable in one of them.

**Type.** Geist for Latin, IBM Plex Sans Arabic for Arabic, Geist Mono for codes, serials and configuration keys — all
self-hosted through `@fontsource` (imported in `main.tsx`; the Latin face is preloaded from `index.html`, and the Arabic
faces carry an Arabic-only `unicode-range`, so an English session never downloads them). Headings track tighter as they
grow (`h1` −0.022em, `h2`/`h3` −0.012em, none in Arabic) and use `text-wrap: balance`. Anything numeric that lines up
in a column gets `.tnum` (tabular figures): attendance totals, step numbers, counts.

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
   subdivided by vendor, and five of its six vendors have a single entry.
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

**Card** is the only resting surface. `rounded-xl border bg-card shadow-card`. Do not nest a card in a card — use
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

> **Never show a validator's own words to a user.** Nothing in the app installs a Zod error map, so a raw
> `error={errors.x?.message}` puts "Invalid GUID" under an empty dropdown and "Too small: expected string to have >=1
> characters" under an empty text box. Name the failure the user can act on — empty-and-required is the one every field
> hits first — and cap inputs with `maxLength` at the schema's own limit so the length messages are unreachable.

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
- **Contrast** ≥ 4.5:1 for text. `text-muted-foreground` is Gray-600 (`#475467`, about 7:1 on white) so hints, e-mail
  lines and table headings read as text; on `bg-muted` it is the tightest pair in the system and passes. Do not invent a
  lighter grey. `text-xs` is 13px, not Tailwind's 12px, for the same reason.
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
| Rows for the 7 providers @1665px content | 6 | 3 |
| Tab stops to cross the provider grid | 7 | 1 |
| Nav clicks to reach Review | 5 | 3 |
| Answers kept when pressing Back | no | yes |
| Rail/Edit can carry a stale answer to Review | — | no (revalidated on exit) |

What changed, and why each was wrong before:

- **One grid for all providers.** Each vendor had its own `<section>` with its own grid, and five of the six vendors
  ship a single integration, so `sm:grid-cols-2 xl:grid-cols-3` laid seven providers out as six near-one-column rows.
  Vendor is now an eyebrow line inside the card. (§4)
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
- **Required fields say so.** Submitting the details step blank produced four raw Zod messages, "Invalid GUID" among
  them. (§5)
- **The rail no longer answers a step nobody reached** — with no provider chosen there are no config fields either, and
  `fields.length === 0` was being read as "this provider needs none".
- **Every exit from the details step revalidates.** The rail and the review screen's Edit made it possible to change a
  field and then leave without re-submitting, so Review — and the create call — used the previous snapshot. (§7)

Regression tests: `apps/web/src/features/devices/pages/device-new-page.test.tsx`. Each one was confirmed to fail
against the pre-redesign component before the fix landed.

## 10. Printed reports

Reports are documents, not screens, and follow the conventions of the fourteen sample layouts (`docs/reports.md`):
company name and title centred with a rule beneath; the period wording each report uses; table headings that repeat on
every page; department headings as bars; codes coloured by meaning (OF blue, leave green, AB red); the attendance-code
legend and `Page X of Y` in the footer; landscape only for the wide grids (Summary, Monthly, Weekly). Hours print in
the tenant's notation (`9.45` = 9 h 45 min by default), clocks and dates in the tenant's formats, Arabic RTL with the
`name_ar` of every entity that has one. Templates live in `apps/worker/src/handlers/reports/render/html.ts`; they are
HTML rendered by Chromium, so the same CSS rules as the app apply — logical properties, tokens, no physical directions.

## 11. Tenant dashboard styles

An organisation picks how its dashboard and app shell look under **Settings → Dashboard** (`settings.dashboard`, one
JSON group per organisation, delivered to every member through `/me`). The choice has three parts:

| Part | Values | What it changes |
|---|---|---|
| `theme` | `emerald` (FlowZa Green, default) · `midnight` (Midnight Indigo) · `classic` (Classic Light) · `desert` (Desert Gold) · `ocean` (Ocean Teal) · `graphite` · `crimson` | Sidebar surface, the whole `brand-*` scale (so `primary`, `ring`, selection and every `text-brand-*` follow), the accent tint, the chart palette, the highlight gradient |
| `layout` | `overview` · `operations` · `executive` | Which widgets the dashboard shows and what it leads with |
| options | `trendDays` (7 · 14 · 30), `showGreeting`, `showQuote`, `showHighlight` | The trend range, the "Good morning, Hassan" heading, the two rail cards |

**Mechanism.** A theme is a block of CSS variables in `globals.css` keyed by `[data-theme='<key>']`; `AppShell` sets the
attribute on `<html>` (`useApplyDashboardTheme`) from the organisation's settings, or from the style an administrator is
previewing in Settings. The `@theme` colour tokens reference those variables (`--color-brand-500: var(--brand-500)`),
so no component knows which style is active — it only ever uses tokens. Dark mode stays a class on `<html>`: each
theme has a `.dark[data-theme]` variant for the values that depend on the mode (the accent tint, and a light sidebar,
which turns dark).

**Tokens a component may use.** Shell: `bg-sidebar`, `text-sidebar-foreground`, `text-sidebar-strong`,
`bg-sidebar-hover`, `bg-sidebar-active`, `text-sidebar-active-foreground`, `text-sidebar-active-icon`,
`border-sidebar-border`, `bg-sidebar-rail`. Charts: `chart-present`, `chart-absent`, `chart-late`, `chart-leave`,
`chart-early`, `chart-overtime`, `chart-missing` (as `bg-`/`text-` utilities, or `var(--color-chart-…)` in Recharts).
Bars: the `.bar-fill` utility (solid in most styles, a gradient in Midnight, Classic, Desert, Ocean and Crimson);
`.hero-gradient` for the highlight card. **Never write `text-white` or `bg-white/10` in the sidebar** — Classic Light
has a white sidebar, and the literal vanishes.

**Thumbnails are the real CSS.** The gallery in Settings renders each miniature inside an element that carries
`data-theme` itself, so the block that styles the real shell styles the preview; there is no second copy of any colour.
`theme.test.tsx` checks that every style in `DASHBOARD_THEMES` has a block with the same token set as the default and a
dark variant, so a style cannot ship half-defined.

**Adding a style.** Add the key to `DASHBOARD_THEMES` in `@flowza/contracts`, a light block and a `.dark` block in
`globals.css` (copy the emerald block and change every value), an icon in `DASHBOARD_THEME_META`, and a name/hint under
`dashboard.themes.<key>` in the `settings` locale (en + ar). Keep text contrast ≥ 4.5:1 on both the sidebar and the
card surfaces; "absent" must never share a hue with the style's accent (Crimson moves it to slate).

**Layouts.** All three are built from the same widgets (`features/dashboard/widgets`), each of which hides itself when
the member lacks the permission behind its data (`attendance.approve` for approvals, `holiday.view`, `attendance.view`,
`device.view`). Charts stack disjoint series — "on time" is present minus late, and the headcount ring carries an
"off / no record" slice — so the numbers always add up to the records or the headcount.

## 12. Motion, smoothness and the frame

The app should never feel like it stalls. Every rule here exists because its opposite was measured as a hitch.

**The frame.** From `md` up the shell is one screen tall and painted in the tenant's sidebar colour; the page sits in a
rounded panel inset from its edges (`#app-scroll`, `components/layout/app-shell.tsx`) that scrolls on its own, under a
frosted top bar (`.glass`). On a phone the document scrolls, so the browser chrome can collapse. Code that scrolls the
page calls `scrollPageToTop()` (`lib/scroll.ts`), never `window.scrollTo` — on a desktop the window does not scroll. A
new page opens at its top; Back and Forward leave the position alone.

**Navigation never waits on the network.** Pages are `lazyPage(() => import(…))` (`lib/lazy-page.ts`), not
`React.lazy`. The sidebar preloads every destination it shows while the browser is idle and jumps the queue for the item
under the pointer or focus (`lib/route-preload.ts`); a preloaded page then renders in the same frame instead of keeping
the previous page frozen while its code downloads. A route guard component that renders the page itself hides it from
the route tree, so it carries the page's preload: `NotesRoute.preload = NotesReviewPage.preload`. Measured with 350 ms
chunk latency: click-to-new-page went from ~480 ms to ~140 ms on average.

**Animate transform and opacity only.** Never `width`, `height`, `top`/`left` or a margin: those re-lay-out the page —
every table — on each frame (the collapsible sidebar no longer tweens its width; its labels fade in instead). Never a
full-screen `backdrop-filter`: it is recomputed every frame anything underneath moves, so dialog scrims are a plain tint
and blur is kept to the small top bar.

**Motion tokens** (`globals.css` `@theme`): `ease-out` and `ease-spring` are critically damped curves — fast start,
long soft settle, no overshoot. Radix layers animate on their `data-state`: menus, selects, tooltips and popovers use
`data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out` scaling from their trigger
(`origin-(--radix-…-content-transform-origin)`); dialogs `animate-dialog-in/out`; the navigation sheet slides from and
back to the start edge (`DialogContent variant="sheet"`, mirrored in Arabic). Pages rise and fade in once, when their
`.page-container` mounts — a refetch, a filter or a tab inside the page does not re-animate. Buttons answer on press
(`active:scale-[0.97]`), not on release.

**Re-render less.** The React Compiler memoises components and hooks (`vite.config.ts`). Modules that import
`react-hook-form` are left out: `formState` is a proxy that subscribes on read, and a form object passed down as a prop is
the same reference after every validation, so a memoised child would never show its errors. Hooks that read storage
(`useMe`'s cached `/me`) hand it over as `initialData: () => …` so it runs once per query, not once per render.

**Reduced motion and transparency** are honoured globally: animations collapse to an instant cross-fade, and `.glass`
turns solid under `prefers-reduced-transparency`.

## 9. Checklist before shipping a screen

- [ ] No physical direction utilities; checked at `dir="rtl"`
- [ ] Light and dark both legible; no untokenised colour without a `dark:` pair
- [ ] Keyboard-only pass: every control reachable, focus visible, composite widgets are one tab stop
- [ ] Loading state is a skeleton shaped like the content; error state offers retry; empty state says what to do next
- [ ] The layout fills its container at 1920px and survives 360px
- [ ] Anything that moves animates `transform`/`opacity` only; pages are `lazyPage`; nothing calls `window.scrollTo` (§12)
- [ ] Every string comes from `t()` and exists in both `en` and `ar`
- [ ] A regression test that fails against the previous behaviour
