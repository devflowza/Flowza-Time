# Phase 11 — End-to-end test matrix, UI scenarios and UI walk

**Prompt:** the Prompt 11 coordinator brief (e2e matrix against the real API in local and hosted modes, Playwright scenarios for
the HR-portal surfaces, an en/ar UI walk, fix what they find). **Branch:** `worktree-agent-a7a5b057f01ecaa6e`, based on `319efde`.
**Date:** 2026-09-28. **Migrations:** none (no defect needed a schema change). **New dependencies:** none.

## 1. How to run

### The matrix (`scripts/e2e-hosted/run.mjs`, Node 22, no dependencies)

Local — Postgres 16 with the repo's migrations and the local seed; the script resets + seeds the database, starts the API and
the worker, mints HS256 tokens for the seed's logins, runs every flow and stops both servers:

```sh
export PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres
node scripts/e2e-hosted/run.mjs --mode=local --reset --start --db=flowza_p11 --api-port=4310
node scripts/e2e-hosted/run.mjs --mode=local --start --db=flowza_p11 --flows=7,8,abuse   # a subset (flow 0 always runs)
```

Hosted — the demo tenant only (Majan Gulf Trading, `27bfe270-5dea-4587-aec3-0f5c23113261`). The password and keys come from the
environment only; the script refuses any other organisation and refuses to start without the explicit flag:

```sh
export E2E_SUPABASE_URL=https://<project>.supabase.co E2E_SUPABASE_ANON_KEY=… E2E_API_URL=https://<api host>/api/v1 \
       E2E_PASSWORD=… E2E_ORG_ID=27bfe270-5dea-4587-aec3-0f5c23113261
node scripts/e2e-hosted/run.mjs --mode=hosted --i-understand-this-writes-to-the-demo-tenant
```

Every flow tags what it creates `e2e:<runId>` and cleans it up (withdraw / cancel, delete its fence, schedule, workflow and
delegation, disconnect the connector, restore the settings it changed — also after a failed flow). Output: a table (flow,
step, expected, actual, PASS / FAIL / KNOWN / SKIP, ms) and `scripts/e2e-hosted/results/<runId>-<mode>.json` (gitignored).
Exit code = number of failed flows. Options, the flows in detail and what hosted mode does not do: `scripts/e2e-hosted/README.md`.

### The UI suite (Playwright, backend double)

```sh
pnpm --filter @flowza/web run build:e2e
CI=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm --filter @flowza/web run test:e2e
# the UI walk (opt-in, chromium only, ~5 minutes): screenshots into scripts/e2e-hosted/results/screens/
E2E_UI_WALK=1 CI=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm --filter @flowza/web exec playwright test e2e/ui-walk.spec.ts --project=chromium
```

`E2E_WEB_PORT=<port>` serves the preview elsewhere when 4173 is taken on a shared machine (the documented gate uses 4173).

## 2. Final local results

Run `20260928201957-f4d1` (`--mode=local --reset --start --db=flowza_p11 --api-port=4310`, 2026-09-28 20:20–20:23 UTC,
2 min 38 s of flows after the reset + seed): **ALL FLOWS PASSED — 146 steps PASS, 1 SKIP, 0 FAIL, 0 KNOWN.**

| Flow | Result | Steps | Time | What it covers |
|---|---|---|---|---|
| 0 | PASS | 8 | 1 s | every login signs in, fixtures (manager, role keys, branch-restricted branch manager), web check-in on for the run |
| 1 | PASS | 13 + 1 SKIP | 34 s | fence preview inside / 5.4 km outside, punch outside refused and not stored, IN / OUT, statuses, normalisation, recompute, stats |
| 2 | PASS | 11 | 9 s | reason → manager queue + HR oversight → rejected with a half-day pay effect (0.5 charged) → in-app notice → re-submitted → approved → notice → charge reversed |
| 3 | PASS | 9 | 2 s | two-level REGULARISATION workflow, level 1 manager, level 2 HR, applied, the day recomputed with the new check-out |
| 4 | PASS | 14 | 11 s | leave apply → edit (old request invalidated) → info asked (notice) → reply → self-approval 403 → approved (notice) → balance; a second request withdrawn and its engine request cancelled |
| 5 | PASS | 5 | 2 s | shift swap approved, both resolve to the other's shift |
| 6 | PASS | 12 | 8 s | HR bulk HALF_DAY, recalculation keeps it, monthly summary counts it, report schedule run now → delivery generated |
| 7 | PASS | 9 | 7 s | delegation: the delegate gets the request (notice) in the manager's seat and decides it "for" the manager |
| 8 | PASS | 9 | 7 s | escalation after 1 h with the worker sweep's clock two hours on: HR added as escalated approver, notified, decides |
| 9 | PASS | 22 | 1 s | auditor reads, 11 writes refused with nothing changed; Sohar branch manager cannot read or edit HQ |
| 10 | PASS | 15 | 13 s | Finance connector vs the in-script mock: test (typed / wrong token / stored), save (masked), one punch pushed, one pulled, no loop-back, disconnect |
| abuse | PASS | 19 | 64 s | foreign ids in paths and bodies, replay, client time, double decision, approved reason edit, batch limits |

The SKIP is flow 1's punch-count step: the run started at 00:20 Asia/Muscat, when a day-shift employee's web punches fall
outside every shift punch window; the recompute step then asserts the engine's documented rule for that case instead (§3, row 7).
The same flows had passed with the normal branch (the punches counted on the day, `SELF_SERVICE_PUNCH`) in the runs at
18:54 (all flows) and 18:59 UTC (flows 2, 4, 7; 22:54 / 22:59 Muscat), before the midnight case was met.

## 3. Defects found and fixed

| # | Found by | Defect | Fix | Regression test |
|---|---|---|---|---|
| 1 | matrix flow 10 | **"Sync now" on the Flowza Finance connector silently did nothing while a scheduled push held the connector's lock**: the manual run exited `skipped: already_running` and the web punch waited for the next poll (up to 60 min). | `edfa611` fix(worker): a MANUAL push waits (bounded, 2 min, cancellable, `lockWaitMs`) for the running one and then pushes; a SCHEDULED run still exits as a no-op. This narrows decision D11 of `09-finance-connector.md` ("a second run exits as a no-op") for the manual trigger only — one push per connector at a time still holds. Documented in `docs/integrations/flowza-finance.md`. | `finance-fixes.test.ts` "Prompt 11 (matrix flow 10): Sync now during a run waits…" and "the wait is bounded…" (fail before) |
| 2 | matrix flows 2–4, 7 | The local seed's self-service employee had no line manager, so the portal's approval flows reached no manager who could sign in (the hosted demo tenant has one). | `f8d026e` seed: the self-service employee reports to the line-manager login (+ employment history). | the matrix itself (flows 2, 3, 4, 7 route to the manager login) |
| 3 | UI walk | **Tabs, Selects and DropdownMenus laid out left to right in Arabic**: Radix falls back to `ltr` without a DirectionProvider and Tabs writes `dir="ltr"` on its root, so whole tab panels (the HR reasons table and its row actions, My requests, the HR calendar) ran LTR, arrow keys went the wrong way, selects and menus were mirrored. | `1f3a2f8` fix(web): `lib/direction` (`directionOf`, `useUiDirection` — one RTL list, also behind the document's `dir`); the UI kit passes it to the three roots, a caller's `dir` still wins. No new dependency (`@radix-ui/react-direction` not added). | `components/ui/direction.test.tsx` (5 of 8 fail on the old kit); the walk's `ltr_widget` check (96 widgets checked in Arabic, 0 LTR) |
| 4 | UI walk | The shared DataTable's column chooser read **"Columns" in every language**, offered an actions column as a blank entry and a drawn heading by its raw id; the selection boxes were announced in English. | `1f3a2f8`: `common.columns / selectAll / selectRow` (en + ar); only columns with a written heading are offered; the chooser button has an accessible name at phone width. | `components/data-table/data-table.test.tsx` (2 of 3 fail before) |
| 5 | UI walk | **The employee portal showed leave types and holidays in English in Arabic** although the organisation gave them an Arabic name (the dashboard's holidays card already used it). | `3814043` fix(portal): additive optional `leaveTypeNameAr` / `nameAr` / `holidaysByDateAr` on the portal DTOs (API fills them); `localName` / `useLocalName` on home, My leave, the apply and conversation dialogs, the month calendar and the team's upcoming leave, with the type list as fallback for an older API build. | `features/portal/arabic-names.test.tsx` (3 of 5 fail before); API `self-service.test.ts` "carries the Arabic names of leave types and holidays to the portal" |
| 6 | UI walk | **The HR reasons review pushed its actions off screen**: the reason column was sized to the whole note (a one-line truncation still counts the full text), so at 1280 px "Approve" showed as "✓ A", in Arabic only the icons remained, and with a long note all four actions were out of view until the table was scrolled sideways. | `295a21e` fix(web): the reason is capped on its content, the actions column is pinned to the inline end (right in English, left in Arabic) with a divider that survives sticking. | `e2e/hr-notes.spec.ts` "a long reason keeps the review actions on screen" (en + ar, desktop + tablet; viewport ratio 0 before) |
| 7 | matrix flow 1 (final run, after local midnight) | Not a product defect: the flow assumed the web punches always land on today's record. Between local midnight and a day shift's punch window they belong to no window, and the engine keeps them out and flags `OUT_OF_WINDOW` on the calendar day — documented and tested (`packages/domain` `attribute.ts`; `calculate.test.ts` "flags OUT_OF_WINDOW punches on the calendar day and keeps them out of the record"). | `34d7046` test(e2e): the step looks on today and yesterday, and at that hour asserts the documented rule (before the day's expected start, `OUT_OF_WINDOW`, no `SELF_SERVICE_PUNCH`); the assertion is not loosened for any other hour. | the matrix (final run exercised this branch) |

No assertion was weakened (row 7 adds the documented alternative for one hour band, it removes nothing). Defects owned by parallel agents were not touched (none of the matrix steps needed a `KNOWN:` mark
in the final run).

## 4. Playwright scenarios

| Surface | Spec |
|---|---|
| Portal check-in | `portal.spec.ts` (preview → punch → reason → listed in My requests), `portal-mobile.spec.ts` |
| Portal requests | `portal-requests.spec.ts` (new): regularisation of a missed check-out — validation, times sent in UTC, level 1 of 2, withdrawal only after confirming |
| Portal leave apply | `leave.spec.ts` |
| Team approvals (manager) | `team.spec.ts` |
| HR attendance notes review | `hr-notes.spec.ts` (new): organisation queue under oversight, an excuse that fills the manager's seat (the dialog names whose), moves to Excused; plus the long-reason layout test |
| HR calendar / summary | `hr-attendance.spec.ts` |
| Approvals inbox + delegation | `approvals.spec.ts` |
| Notification preferences | `notifications.spec.ts` |
| Settings → Integrations → Flowza Finance | `integrations.spec.ts` (new): test with typed values (a rejected credential is reported, nothing saved), save (token masked, sent once), test with the stored token (never echoed), disconnect only after confirming (cancel sends nothing), reconnect |

The backend double (`e2e/support/mock-backend.ts`) gained stateful handlers for the Finance integration, the HR reasons queue
and the portal regularisations, DELETE routing, a preflight answer that names `Authorization` (needed when the preview is not on
4173), and the walk's fixtures (`e2e/support/walk-fixtures.ts`).

## 5. UI walk

28 pages × en / ar × 1280×800 / 390×844 = 112 screenshots (`scripts/e2e-hosted/results/screens/`, gitignored, with
`ui-walk.json`). Automatic checks: sideways page scroll (naming the elements that stick out), raw i18n keys, English UI
strings on the Arabic rendering, cut-off buttons outside scroll containers, page errors, and in Arabic tab strips / selects /
menus whose nearest `dir` is `ltr` (a per-page widget count is recorded as a positive control). Findings: defects 3–6 above
(3 and 6 by looking at the screenshots — the automatic checks could not see them, which is why the `ltr_widget` check and the
long-reason Playwright test were added). Final run: **0 findings**. Two automatic findings were fixture data, not defects
(a role called "Owner", a department called "Operations" — the organisation's own words, shown as typed) and are allowlisted
in the spec with that reason.

Seen and left (cosmetic, not blocking):
- On the portal home at 390 px the StatCard hints ("18 of 19 days…") are truncated with an ellipsis in Arabic, and "153h 00m" wraps.
- The approvals inbox search placeholder ("Search employee name or number") is cut at 1280 px.
- Master-data names outside the portal (HR leave pages, the team workspace, the dashboard team cards, the profile's branch /
  department / designation, the portal shift page's holiday name, the comp-off holiday name) still show the primary name only;
  the portal's leave and holiday names were the ones in the employee's way.

## 6. Gates

Run on `2ab9b8b`; the commits after it (`34d7046`, the matrix script + its README, and this report) touch no package, app or migration. The matrix of §2 ran on `34d7046`.

| Gate | Result |
|---|---|
| `pnpm build:packages` | ✓ |
| `pnpm lint` | ✓ (0 warnings) |
| `pnpm -r --filter "./apps/*" run typecheck` | ✓ |
| `pnpm test:unit` | ✓ shared 4, contracts 45, device-providers 286, domain 347, database 21 |
| `pnpm --filter @flowza/web run test` | ✓ 85 files, 479 tests |
| `PGDATABASE=flowza_p11_rls … run-rls-tests.sh` | ✓ RLS tests passed |
| `pnpm test:db` | ✓ 5 files, 24 tests |
| `pnpm --filter @flowza/api run test` | ✓ 37 files, 489 tests |
| `pnpm --filter @flowza/worker exec vitest run` | ✓ 227 passed, 1 skipped |
| `pnpm -r --filter "./apps/*" run build` | ✓ |
| `PGDATABASE=flowza_p11_ci2 bash scripts/db-reset-local.sh` | ✓ all migrations |
| single-transaction replay (`replay-single-tx.sh … flowza_p11_tx`) | ✓ (no migration added by this phase) |
| `build:e2e` + `test:e2e` (`CI=1`, port 4173) | ✓ 74 passed, 2 skipped (the opt-in UI walk, both projects) |
| UI walk (`E2E_UI_WALK=1`) | ✓ 112 screenshots, 0 findings |
| local matrix | ✓ all flows PASS (§2) |

## 7. Limits

- Hosted mode was not run from here (no demo-tenant credentials in this environment); it is exercised by the same code paths as
  local mode except for sign-in (password grant) and what the README lists as local-only: flow 8 (needs the worker's dev hook
  `apps/worker/src/tools/run-approval-reminders.ts`, which refuses production), the report-copy check of flow 6, a real second
  organisation for the abuse pass (a random id is used), and flow 10 beyond test connection (opt-in `E2E_FINANCE_TEST=1`).
- Hosted mode changes the tenant's self-service attendance settings for the run's duration and restores them at the end.
- The UI suite runs against a backend double; the matrix is what exercises the real API, worker and database.
- The security invariants (catalogue-driven RLS, route authorisation matrix, abuse tests in `apps/api/src/test/`) are Prompt 10's;
  the matrix's abuse pass is a black-box complement, not a replacement.
