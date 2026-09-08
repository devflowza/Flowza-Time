# ADR-008: Reports are one document model rendered three ways, with PDF through headless Chromium on a dedicated worker

**Status:** Accepted · **Date:** 2026-09-09

## Problem
Fourteen legacy report layouts (docs/reports.md) must be reproduced 1:1 for every tenant — department grouping,
two-level headers, `H.MM` hours notation, colour-coded attendance codes, a legend footer, `Page X of Y`, landscape and
portrait pages — in English and Arabic (RTL), as PDF, XLSX and CSV. The Reports module had every layer except the one
that produces a file: no worker handler existed for `GENERATE_REPORT`.

## Options
1. **A JS PDF library (pdfmake / pdfkit).** Small footprint, but Arabic needs manual shaping and bidi, repeated table
   headers and page numbering are hand-built, and every layout is re-implemented in a JSON DSL — three renderers with
   three ideas of a table.
2. **HTML templates rendered by headless Chromium** (`playwright-core` driving the OS Chromium). Full CSS print
   support — `thead` repetition, `@page` orientation, running footers with page numbers, RTL and Arabic shaping for
   free — at the cost of ~250 MB of image and 200–400 MB of peak memory per render.
3. Rendering in the API request. Rejected outright: reports of a large tenant take a minute; AGENTS.md rule 5 makes
   anything that heavy a worker job.

## Decision
- One renderer-neutral **`ReportDocument`** (columns with optional group headers, sections with headings / header
  fields / page breaks, cells with tone and typed numbers). Every report definition produces it; CSV, XLSX and PDF are
  views of the same object, so ordering, values and row counts are identical across formats by construction.
- **PDF = HTML → Chromium** (option 2). Templates are plain HTML/CSS in `render/html.ts`.
- **A dedicated reports worker** (`fly.reports.toml`, `flowza-time-reports`): the same image built with
  `WITH_CHROMIUM=1` (Alpine Chromium + Noto Sans / Noto Sans Arabic), consuming only the `reports` queue on 1 GB. The
  general worker is built without Chromium and refuses PDF requests immediately and non-retryably, so a misrouted job
  fails with a clear message rather than retrying.
- **Values come from the engine, not from the legacy vendor's arithmetic.** OT1 = regular overtime, OT2 = weekly-off
  and holiday overtime, UT = base − worked; rounding and breaks are the tenant's rule set. The legacy system's own
  rounding is deliberately not emulated (plan decision #4).
- **Catalogue honesty.** `ReportTypeDefinition.status` is `available` or `planned`; planned types are hidden from
  `/report-types` and refused by `POST /reports`, and a unit test asserts the catalogue and the worker registry are the
  same list.

## Consequences
- Adding a report is one definition file plus a catalogue entry and labels; the renderers, footer, legend, grouping,
  sorting and the three formats are shared (docs/reports.md, "Adding a report type").
- Two new dependencies: `playwright-core` (worker) and the Chromium/font packages in the reports image.
- The reports app is a second Fly machine to deploy and monitor (go-live §3b). Until it exists CSV/XLSX work from the
  general worker and PDF requests fail visibly.
- Large tenants are bounded by a cell cap (rows × columns) with an actionable FAILED message rather than a timeout;
  splitting by branch is the documented way round it.
