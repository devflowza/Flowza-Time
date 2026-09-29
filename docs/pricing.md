# Plans, pricing, modules and billing

FlowZa Time is sold per **user** — a licensed employee whose attendance FlowZa Time keeps (each one can also sign in to the
self-service portal). Plans differ by the **modules** they include and the number of users their base price covers. Prices are
in Omani rials (OMR, three decimals) and **exclude 5% VAT**, which every invoice adds.

The reference package is **Professional: 500 OMR a year for 11 users** (+ 25 OMR VAT = 525 OMR). Everything else is
derived from it: yearly = ten months of monthly (two months free), and the per-user price falls as organisations grow.

## The plans

| Plan | Yearly | Monthly | Users included | Extra user / year (month) | Modules | Limits (max) |
|---|---|---|---|---|---|---|
| **Trial** | free, 14 days | — | — | — | every module | 50 employees, 3 terminals, 2 branches |
| **Starter** | 250 | 25 | 11 | 20 (2) | Devices & sync, Employee self-service | 50 employees, 2 terminals, 2 branches |
| **Professional** (reference) | **500** | 50 | **11** | 40 (4) | Starter + Leave, Web check-in & geofencing, Manager workspace, Payroll, Scheduled reports | 100 employees, 5 terminals, 5 branches |
| **Business** | 1,100 | 110 | 25 | 35 (3.5) | Professional + Flowza Finance integration | 1,000 employees, 50 terminals, 25 branches |
| **Enterprise** | custom | custom | — | — | every module | 100,000 employees, 5,000 terminals |

What a customer pays (yearly, excl. VAT):

| Users | Starter | Professional | Business |
|---|---|---|---|
| 11 | 250 (1.89 / user / month) | **500 (3.79 / user / month)** | 1,100 |
| 20 | 430 | 860 | 1,100 |
| 25 | 530 | 1,060 | 1,100 (3.67 / user / month) |
| 40 | 830 | 1,660 | 1,625 |
| 100 | — (above the 50-employee cap) | — (above the 100-employee cap) | 3,725 (3.10 / user / month) |

Professional and Business cost the same at 33 users (1,380 OMR), so a growing customer moves up naturally and gets the Flowza Finance
integration with it. Seats below the included users still pay the base price.

**Why these numbers.** 500 OMR for 11 users is 45.45 OMR per user per year. An extra Professional user at 40 OMR keeps the
marginal price just under the average, so adding people is never a reason to leave; Starter is half the reference package
(no leave, geofences, payroll or manager workspace — plain attendance with terminals), Business is 2.2× for 2.3× the users
plus the Finance integration. Terminals are not priced: customers bring their own devices, and the plan limits the count.

The arithmetic lives once, in `@flowza/contracts` (`quoteSubscription`, `computeInvoiceTotals`, `subscriptionInvoiceLines`),
in integer baisa, and is used by the API (invoices, revenue figures) and the web (plan editor, calculator, tenant page).

## Modules

| Key | Module | What it covers (web routes / API prefixes under `/orgs/:orgId/`) |
|---|---|---|
| `devices` | Devices & sync | `/devices*`, `/sync*`, `/reconciliation`; `devices`, `device-groups`, `pin-mappings`, `sync`, `employees/:id/devices` |
| `self_service` | Employee self-service portal | `/my*`; `me/*`, `employees/:id/portal-access` |
| `geofences` | Web check-in & geofencing | `/my/checkin`, `/attendance/geofences`, selfie review; `geofences`, `me/punch`, `me/selfie-checkin(s)`, `attendance/selfie-checkins` |
| `leave` | Leave management | `/leave`, `/my/leave`; `leave-types`, `leave-records`, `leave-balances`, `leave-allocations`, `leave-calendar`, `me/leave`, `me/comp-off`, `team/leave` |
| `manager_workspace` | Manager workspace | `/team`; `team/summary`, `team/attendance`, `team/leave`, `me/team/*` (`team/pending-counts` stays core: it is the approvals badge) |
| `payroll` | Payroll | `/payroll`; `payroll/*` |
| `report_schedules` | Scheduled reports | schedules and sharing on `/reports`; `report-schedules`, `report-deliveries`, `report-recipients`, `reports/share` |
| `finance_integration` | Flowza Finance integration | Settings → Integrations; `integrations/finance*` |

The core — employees and organisation, attendance and corrections, shifts and holidays, reports, approvals, users, settings,
audit — is never switchable.

**The rule** (one SQL function, `app._org_module_states`): a module is on for a tenant when it is available fleet-wide
(`modules.is_available`) **and** the subscription has not lapsed (`expired` / `cancelled` — never inferred from a date, so a
trial past its end date keeps working until a platform admin decides) **and** the tenant's override (`organization_modules`)
says on, or — without an override — the plan includes it.

Enforcement, three layers:
1. **API** — `moduleGate()` after the tenant and MFA gates answers `403 FEATURE_DISABLED` (`details.reason = MODULE_DISABLED`,
   `details.module`) before any body is read. The disabled set comes with `app.principal_snapshot`, so the gate costs no
   extra round trip and a platform admin's change applies to the next request.
2. **Worker** — scheduled report deliveries and Flowza Finance pushes skip a tenant whose module is off.
3. **Web** — `/me` carries `modules` per membership; the sidebar, settings sections, dashboard cards and sub-tabs hide what is
   off, and `RequireModule` explains a page instead of rendering it.

Switching a module off **never deletes data and never stops a terminal's punches from being recorded**; switching it back on
restores everything.

## The admin panel (`/adm`) — Flowza Finance parity

| Flowza Finance | FlowZa Time | What it does |
|---|---|---|
| Modules | **Modules** (`/adm/modules`) | Each module with its adoption (tenants on / total, overrides), the fleet-wide switch, and "turn on / off for every tenant" / "every tenant back to its plan" — each with a reason, audited on every tenant |
| Tenant → Modules | **Tenant → Modules** | Per-tenant switches: on / off overrides the plan, "Back to plan" removes the override |
| Plans & Pricing | **Plans & pricing** (`/adm/plans`) | Plan cards (price per cycle, users included, extra-user price, modules, limits, live subscribers), the plan editor, a pricing calculator |
| Subscriptions & Billing | **Subscriptions & billing** (`/adm/billing`) | MRR / ARR, outstanding and overdue invoices, collected in 30 days; subscriptions by plan; every invoice and payment |
| Tenant → Subscription | **Tenant → Subscription** | Plan, status, billing cycle, paid users, price; change plan / cycle / users / dates, extend trial |
| Tenant → Payments | **Tenant → Billing** | The tenant's invoices and payments; issue an invoice |
| Platform settings | **Platform settings** (`/adm/settings`) | Platform name, support e-mail, currency, VAT rate, invoice prefix, payment terms, seller name / VAT number / address, bank details |

### Invoices and payments

- **Issue** (`POST /platform/billing/invoices`): a plan priced for a cycle and a number of users (`subscriptionInvoiceLines`) and /
  or custom lines (installation, terminals, training), an optional discount, VAT at the platform rate. Numbers are
  `FZT-2026-00001` (prefix from the settings, one counter per prefix and Muscat year, gap-free for committed invoices). The
  seller and the customer are snapshotted on the invoice.
- **Pay** (`…/payments`): bank transfer, card, cash, cheque, online or other, with a reference; a payment may not exceed the
  balance, a refund may not exceed what was paid. Payments are append-only.
- **Activate**: when a plan invoice is fully paid, the subscription moves to the invoiced plan, cycle, users and period
  (`status = active`), and a tenant on trial becomes active — once, audited on the tenant.
- **Void**: only an invoice with nothing paid on it (refund first); it stays on record.
- **Print**: the invoice dialog prints a tax invoice (or saves it as PDF from the browser).

No payment gateway is wired yet: payments are recorded by a platform admin (bank transfer is the norm for Omani B2B). A
gateway (Thawani / Stripe) would call the same `recordPayment` path from its webhook.

### Paid users cap employees

`subscriptions.seats` — the users a tenant pays for — replaces the plan's employee limit when set: creating an employee
beyond it answers `402 ENTITLEMENT_EXCEEDED`. Empty seats fall back to the plan limit (every tenant that existed before this
change keeps its limit).

## Database (migration `20260929000600_modules_plans_billing.sql`)

`modules`, `organization_modules`, `plans.{modules, included_users, trial_days, is_custom}`, `subscriptions.{billing_cycle, seats}`,
`billing_invoices`, `billing_payments`, `billing_invoice_counters`, `platform_settings`, the functions
`app._org_module_states` / `app.org_module_states` / `app.org_module_enabled` / `app.next_billing_invoice_number`, and
`app.principal_snapshot` extended with `disabledModules`. Every table has RLS (forced where it applies), refuses the data API, and
the tenant-scoped ones refuse client writes (system context only, after `requirePlatformAdmin`). The seed changes no existing
tenant: Trial, Business and Enterprise include every module; only Starter (no tenant on it) is a subset.

**Deploy order:** apply the migration before deploying the API (the API reads `disabledModules` and falls back to "nothing off"
when the key is absent, but the new endpoints need the tables).
