# FlowZa Time — website content

Ready-to-paste copy for the public marketing site. Every claim here is traceable to something the product does
**today**; §10 is the ledger that proves it and §11 lists the sentences we may not write yet. This file is content,
not code: nothing in `apps/` reads it.

## How to use this document

- **One section per page block.** Headings map to the page and the block on it, in the order a visitor meets them.
- **Variants marked A / B / C are alternatives.** Pick one per slot; never run all three.
- **`{{ }}` marks a decision nobody has made yet** — price, phone number, address, a customer name. Do not ship a page
  with braces still in it.
- **Spelling is British/Omani English** — *organisation, synchronisation, recognise, licence* — because the product UI
  is. A marketing site that says "organization" next to an app that says "organisation" reads as two products.
- **§10 and §11 are binding.** The engineering rule that a vendor is never described as supported until the adapter has
  run against real hardware applies to the website too — that is where the claim actually reaches a buyer.
- **Voice:** say the specific thing. "Every minute traces back to the punch that made it" beats "powerful analytics".
  Name the boundaries out loud — the product's own UI already does ("FlowZa is not payroll"), and buyers trust it.

---

## 0. Positioning

**Category:** cloud attendance and workforce time management for multi-branch organisations in the GCC.

**One-liner:** FlowZa Time turns punches from any mix of attendance machines into payroll-ready hours you can defend,
minute by minute.

**Elevator paragraph:** Most attendance software either talks to one vendor's terminals or hands you a number with no
working behind it. FlowZa Time does neither. It presents every device — whichever vendor, whichever branch — as one
inventory with one health view, keeps every raw punch exactly as the device sent it, and computes each day through a
rule set you can read. When payroll asks why an employee shows 14 minutes of overtime, the answer is on screen: the
punches, the shift that applied, the rules in force that day, and every correction with who asked and who approved.

**Sold to:** HR and admin teams at organisations with several branches and more than one brand of terminal. Not to
device technicians.

**The three things we sell on:**

1. **Explainability.** A traced calculation, not a black box.
2. **Device plurality.** One cloud in front of a mixed estate, rather than one console per vendor.
3. **Made for here.** Arabic and RTL throughout, Ramadan hours, Friday/Saturday weekends, per-branch holidays and
   timezones — built in, not bolted on.

**Who it is not for (say this out loud, it qualifies leads):** single-site companies with ten staff and one clock;
anyone looking for a payroll engine; anyone who wants biometric templates warehoused centrally.

---

## 1. Home page

### 1.1 Hero

**Headline — A (recommended, leads with the differentiator):**
> Every attendance figure, traced back to the punch that made it.

**Headline — B (leads with the device problem):**
> Every attendance machine you own. One cloud.

**Headline — C (leads with the payroll outcome):**
> Payroll-ready hours you can defend line by line.

**Sub-headline:**
> FlowZa Time connects attendance terminals from many vendors to one cloud, pushes your employees out to them, and
> turns the punches that come back into daily attendance you can explain — late minutes, overtime, absences and all.
> Built for multi-branch organisations across Oman and the GCC, in English and Arabic.

**Primary CTA:** Book a demo
**Secondary CTA:** See how the engine works

> Note for the build: a "Start free trial" CTA is only honest once self-service sign-up is enabled on the hosted
> project. The application supports it; the deployment currently does not. Until then, point the primary CTA at a
> booking form. See §10, row *Trial*.

**Hero support line (small, under the buttons):**
> No biometric templates leave your devices. Your data is isolated per organisation at the database level.

### 1.2 Trust strip

Use plain statements, not logos we do not have. Four items, one line each:

- Built for 500+ devices and 10,000+ employees per organisation
- English and Arabic, right-to-left throughout
- Row-level tenant isolation on every table
- Immutable audit trail on every sensitive action

### 1.3 The problem

**Heading:** Attendance breaks in three places. We fixed all three.

| Block | Copy |
|---|---|
| **Your devices disagree with each other** | ZKTeco at head office, a different brand at the site, something older in the warehouse. Each with its own console, its own export, its own idea of a date. HR ends up reconciling spreadsheets. |
| **Employees exist in some places and not others** | Someone joins, gets added to three terminals out of five, and turns up "absent" at the branch nobody updated. You discover it on payroll day. |
| **Nobody can explain the number** | The report says 14 minutes late. Why? Which punch? Which shift? Was there a grace period that month? Without an answer, the argument is decided by whoever is more senior. |

**Closing line:** FlowZa Time answers all three from one screen: one device inventory, one push, one traceable
calculation.

### 1.4 How it works

**Heading:** From punch to payroll, in four steps

1. **Connect your devices.** Add each terminal to the inventory with its branch, timezone and connection method —
   whether it pushes to us, we poll a vendor cloud, or the vendor sends webhooks. Health, last contact and every
   exchange are visible per device.
2. **Push employees once.** Create an employee in FlowZa, click *Sync to devices*, and the job fans out to every device
   at that branch. You see exactly which succeeded, which failed and which were offline — per device, with retries.
3. **Punches become explainable days.** Raw transactions are stored **unchanged**, then resolved to employees, then
   computed into a daily record against the shift and rule set that applied on that date. The trace travels with the
   record.
4. **Close the period and hand payroll a clean file.** Lock the month, and each employee's summary is finalised and
   versioned. That file is the hand-over boundary — FlowZa is not payroll and does not try to become it.

### 1.5 Feature grid

Twelve cards, heading plus one sentence.

| Card | Copy |
|---|---|
| **Device inventory** | Every terminal across every branch in one list, with capability-aware actions, health and logs. |
| **Sync engine** | Queued, retried, throttled jobs with per-organisation fairness — one busy tenant never starves another. |
| **Attendance engine** | Deterministic daily records: late, early, worked, overtime, under-time, half-days, missing punches. |
| **Shifts and rule sets** | Fixed, flexible, overnight and rotational shifts; effective-dated rules resolved per branch. |
| **Leave** | Leave days are never marked absent. Paid, unpaid, half-day and "counts as present" types all behave correctly. |
| **Corrections and approvals** | Originals are never edited. An approved correction adds or voids an event, and the day recomputes. |
| **Reports** | Fourteen ready layouts as CSV, XLSX or PDF, generated in the background and audited on download. |
| **Payroll summaries** | Locked, versioned period totals per employee — the clean feed your payroll run consumes. |
| **Users, roles and branches** | Forty-four permissions, custom roles, and branch scoping so a manager sees only their sites. |
| **Audit log** | Every create, update, delete and sensitive read, immutable, with the before-and-after diff. |
| **Notifications** | In-app and email, driven by what actually happened, with per-user preferences. |
| **Arabic and RTL** | The whole interface mirrors — and reports print in Arabic with your Arabic department and shift names. |

### 1.6 The explainability section (the one that wins deals)

**Heading:** Open any number. See the working.

**Body:**
> Attendance software usually gives you a total and asks you to trust it. FlowZa keeps the whole chain and shows it.
>
> Every daily record carries its trace: the raw punches as the device sent them, which shift was resolved for that
> employee on that date and why, the rule set in force — grace, thresholds, rounding, overtime blocks — and any
> correction with the requester, the reason and the approver.
>
> Raw transactions are immutable. Events are void-only. Corrections add, never overwrite. When a record is recomputed,
> the previous version is kept. So the question is never "what does the system say now" but "what did it say, when, and
> on what basis" — which is the only version of the question that settles a dispute.

**Pull quote for the block:**
> If a figure cannot be explained, it cannot be defended. So we kept the evidence.

### 1.7 Devices

**Heading:** One cloud in front of a mixed estate

**Body:**
> Terminals arrive in a business one purchase at a time, and they never match. FlowZa puts a provider adapter in front
> of each one, so the rest of the product — the engine, the reports, your HR team — only ever sees an employee and a
> punch.
>
> Devices reach us in whichever way they can: pushing to our endpoint, through a vendor's cloud API, through vendor
> webhooks, or through a server you host yourself. Whichever path, punches land in the same place, deduplicated, with
> the device's own local time preserved alongside the UTC instant.

**Status — write it exactly like this, no wider (see §10):**

- **Live in pilot:** ZKTeco terminals running PUSH/ADMS firmware — the handshake, attendance log, user records and
  device commands are implemented and covered by tests, and we are verifying them on hardware with our first Oman
  customers now.
- **On the roadmap:** Hikvision, Suprema, Anviz, eSSL, FingerTec, Matrix and NITGEN. The research is done and the
  adapter framework is built; each vendor ships when it has been verified against a real device — not before.

**Line to close the block:**
> We will not tell you a device is supported until we have run it. If your estate includes a vendor on the roadmap,
> talk to us about the verification schedule.

### 1.8 Built for the GCC

**Heading:** Not translated afterwards. Built this way.

| Item | Copy |
|---|---|
| **Arabic, right to left** | The entire interface mirrors — navigation, tables, forms, keyboard order. Reports print RTL with Arabic labels and your Arabic names for departments, designations, shifts and leave types. |
| **Ramadan hours** | Set the date range and eligibility; scheduled hours shrink, expected end times move earlier, and the day is flagged so the change is visible on the record. |
| **Your working week** | The week starts on the day your organisation starts it. Weekly offs are per branch, and work on a weekly off or a public holiday keeps the status and counts as its own category of overtime. |
| **Every branch on its own clock** | Branch timezone, GPS location, holiday calendar and weekly off pattern — a Salalah site and a Sohar site can differ, and the engine respects both. |
| **Hours the way your team already reads them** | `9.45` means nine hours forty-five minutes, not nine and a bit. Attendance codes, overtime categories and the legend under every report follow the conventions your staff know. |

### 1.9 Security and privacy

**Heading:** Isolation you can point at, not a promise

- **Tenant isolation is enforced by the database.** Row-level security is on every tenant table, and the migration
  fails if a table is missing a policy. It is not a `WHERE` clause someone can forget.
- **No biometric templates stored centrally.** Fingerprint and face templates are discarded at the door. Enrolment
  stays on the device where it belongs.
- **Device credentials are encrypted per device.** AES-256-GCM under rotatable master keys, bound to the device so
  ciphertext cannot be moved. Your team sees masked values; the application decrypts only for the call itself.
- **Our own staff cannot browse your data.** Platform administrators see organisation metadata only. Reaching tenant
  data requires an explicit, time-boxed, reason-bearing grant — recorded, revocable, and visible in your audit log.
- **Everything sensitive is audited.** Creates, updates, deletes and sensitive reads, append-only, exportable.
- **Sign-in you can harden.** Twelve-character minimum with mixed character classes, TOTP multi-factor enrolment, and
  login history recorded at the point of password verification.

**Compliance line:** Designed against Oman's PDPL, with UAE and Saudi data-protection requirements in scope for
expansion. Data residency and retention are configurable per organisation. {{Confirm with counsel before publishing a
compliance claim stronger than "designed against".}}

### 1.10 Reports

**Heading:** The reports your HR team already prints

**Body:**
> Fourteen layouts, built from real reports GCC HR teams hand to management every month — daily, detail, summary,
> monthly, weekly, absentees, casual and sick leave, late attendance, missed punches, employee directory, inactive
> employees, audit trail and weekly in/out.
>
> Each generates in the background so a long month never ties up your browser, arrives as CSV, XLSX or PDF, and is
> stored securely for seven days. Every download is audited. Hours notation, attendance codes and the legend follow
> your organisation's settings, and any report can be produced in Arabic.

### 1.11 Pricing teaser

**Heading:** Priced by what you actually run
**Body:** Four tiers, from a 14-day evaluation to multi-country estates. Every tier includes the attendance engine,
reports and the audit trail — you are choosing scale, not buying back the basics.
**CTA:** See pricing

### 1.12 Home FAQ (five, expanded set in §5)

**Does FlowZa replace my payroll system?**
No, and it is not trying to. FlowZa produces the locked, versioned period summary your payroll run consumes. Keeping
that boundary sharp is what lets us be rigorous about the attendance side.

**We have terminals from three different vendors. Is that a problem?**
That is the case we were built for. Each vendor sits behind an adapter, so your HR team sees one inventory and one sync
view. What matters is which of your specific vendors we have verified — ask us, and we will tell you exactly where each
one stands.

**What happens when a device is offline?**
The sync job records it as offline rather than failed, and retries with backoff. Punches buffered on the device arrive
when it reconnects and are deduplicated on the way in, so nothing is double-counted.

**Can a branch manager see other branches?**
Only if you let them. Membership can be scoped to specific branches, and the scope is enforced in the database as well
as the application — so it holds for reports and exports too, not just the screens.

**Do you store fingerprints?**
No. Biometric templates are dropped at ingestion. Enrolment stays on the device.

### 1.13 Closing CTA

**Heading:** See it on your own devices
**Body:** A 30-minute walkthrough on a seeded system — a five-branch organisation, 500 employees, twenty devices and a
month of real punches through the live engine. Bring your hardest attendance question.
**Button:** Book a demo

---

## 2. Product pages

### 2.1 Devices and synchronisation

**H1:** Your whole device estate, in one place
**Intro:** Add a terminal, tell FlowZa where it lives, and it joins one inventory with one health view — regardless of
vendor, protocol or how it reaches us.

**Sections:**
- **Four ways in.** Devices that push to us, vendor clouds we poll, vendor webhooks we receive, and servers you host
  yourself. All four end in the same place: a raw transaction, stored unchanged.
- **Employees pushed, and proven.** One click fans out to every device at a branch. Each device reports success,
  failure, offline or unsupported, with attempt history — so "I thought he was added" stops being a category of
  problem.
- **Jobs that behave.** Work is queued, retried with backoff, throttled to what each vendor tolerates, and shared
  fairly between organisations. Nothing blocks the device: it is answered immediately and the heavy work happens
  behind.
- **Unknown terminals are quarantined.** A device nobody registered lands in a pending list until an administrator
  claims it. It never silently starts feeding data.
- **Health you can act on.** Last contact, recent exchanges, errors in plain words, and the exact command that failed.

### 2.2 The attendance engine

**H1:** Deterministic, traced, and the same answer every time
**Intro:** The engine is pure computation: the same punches, shift and rules always produce the same record. That is
what makes recomputation safe and disputes settleable.

**What it computes:** late and early-departure minutes against grace and threshold; worked minutes net of breaks;
overtime after a configurable start, rounded down to whole blocks, capped per day; under-hours and half-days;
missing-in and missing-out handled the way your policy says — flag it, assume the shift end, treat as absent or treat
as half-day; absence only once the day is genuinely over.

**How it decides which shift applied:** employee, then team, then department, then branch, then organisation — each
effective-dated, with rotational patterns resolved from their anchor date. Overnight shifts are handled as one day, not
two halves.

**What happens on holidays and weekly offs:** the day keeps its status, work on it is flagged, and — where your rules
allow — the worked minutes land in their own overtime category rather than hiding inside the normal total.

**Recomputation:** a new punch, an approved correction, a rule change, a new holiday or an explicit request all
retrigger the day. Anything inside a locked period is skipped and listed, never silently rewritten.

### 2.3 Shifts, rules and leave

**H1:** Your policy, written down once
**Intro:** Fixed, flexible, overnight and rotational shifts. Rule sets that are effective-dated and resolvable per
branch, so "the grace period changed in March" is a fact the system knows rather than an argument it loses.
**Leave block:** Leave records feed the engine directly — a day on approved leave is never marked absent. Leave types
carry their own code on reports, and you decide which count as present, which are paid, and which are half-days.

### 2.4 Corrections and approvals

**H1:** Fix the record without losing the truth
**Body:** A forgotten punch is not a reason to edit history. A correction is a request with a reason; once approved it
adds or voids an event and the day recomputes, keeping the previous version. The original device transaction is never
touched. Managers see a queue scoped to their branches, and every decision is audited with who, when and why.

### 2.5 Reports and exports

**H1:** Fourteen layouts, three formats, one audit trail
**Body:** Reuse §1.10, then add: reports run in the background with per-organisation concurrency, so one tenant's
year-end export never blocks another's Monday morning. Oversized requests fail fast with a message that tells you how
to narrow the period or split by branch — rather than timing out twenty minutes later.

### 2.6 The payroll hand-over

**H1:** The clean feed, and where we stop
**Body:** Close the period and each employee's summary is finalised, locked and versioned: present days, absences,
leave by type, worked hours, overtime by category, under-time. Export it, or let your payroll system read it. If a
correction lands after the lock, it does not silently change history — it produces a new version you can see.
**Boundary line:** FlowZa Time is not a payroll engine. It has no view on your salary structure, gratuity or WPS file.
It gives the system that does have those views something it can trust.

### 2.7 Security, roles and tenancy

**H1:** Who sees what, enforced twice
**Body:** Every request is authorised in the application and again by the database. Permissions are checked at the
service layer for a clear answer, and row-level security independently restricts what the query can return — so a
missed check is a bug, not a breach. Roles are built from forty-four individual permissions; memberships can be scoped
to branches; nothing authorisation-relevant is trusted from the token, so a suspension or a role change takes effect on
the next request.
Then reuse the bullets from §1.9.

### 2.8 Arabic and the region

**H1:** Arabic is not a setting we added late
**Body:** Reuse §1.8, then add: machine-shaped values — device serials, timezones, IP addresses — stay left-to-right
inside Arabic text, because a reversed serial number is a support call. Directional icons mirror; clocks and plugs do
not. Dates, times, the first day of the week and number formats all follow the organisation's regional settings.

---

## 3. Solutions by persona

Short pages or one page with anchors. Same shape: the day they have now, what changes, the three features that matter.

| Persona | Headline | The line that lands |
|---|---|---|
| **HR manager** | Close the month without the spreadsheet | "Corrections, approvals and the fourteen reports your management already expects — without exporting anything into Excel to make it add up." |
| **Attendance / IT administrator** | Every terminal, every exchange, one screen | "Stop logging into four vendor consoles. Add the device once, see its health, and read the exact error when something fails." |
| **Branch manager** | Only your branches, and only the decisions that are yours | "A queue of correction requests for your sites, with the punches attached, and a dashboard that stops at your boundary." |
| **Payroll and finance** | A locked feed, versioned, with the working attached | "Read-only on attendance, authoritative on the summary. When someone disputes an overtime figure, open the trace." |
| **Owner / operations director** | Multi-branch attendance that survives an audit | "Immutable raw data, an append-only audit log, and a vendor whose own staff cannot browse your data without a recorded, time-boxed grant." |

---

## 4. Pricing page

**H1:** Pricing that follows your estate
**Sub:** Every plan includes the attendance engine, the audit trail and the standard reports. Tiers differ by scale —
employees, devices, branches, users, storage and how long raw punches are retained.

| | **Trial** | **Starter** | **Business** | **Enterprise** |
|---|---|---|---|---|
| For | A 14-day evaluation | Small businesses | Multi-branch organisations | Large, multi-country estates |
| Price | Free, 14 days | {{price}} | {{price}} | Talk to us |
| Employees | 50 | 100 | 1,000 | 100,000 |
| Devices | 3 | 5 | 50 | 5,000 |
| Branches | 2 | 3 | 25 | 5,000 |
| Users | 5 | 10 | 50 | 5,000 |
| Report storage | 512 MB | 2 GB | 20 GB | 1 TB |
| Raw punch retention | 180 days | 2 years | 3 years | 10 years |
| Standard reports | ✓ | ✓ | ✓ | ✓ |
| Email notifications | — | ✓ | ✓ | ✓ |

> Roadmap entitlements — advanced report types, single sign-on, outbound webhooks — are **not** to be printed on the
> pricing table as included features until their flags are on by default. See §10, row *Plan entitlements*. Sell them,
> if at all, as a named roadmap under the table with a date you can keep.

**Under-table copy:** All plans include unlimited punches within your device count, Arabic and English, the full audit
trail, and support in Arabic and English during GCC business hours. {{Confirm support hours and channels.}}

**Pricing FAQ:**
- *What counts as an employee?* An active employee record. People who have left keep their history and stop counting.
- *What if we exceed a limit?* You are warned before it bites, and limits are enforced predictably rather than by
  silently dropping data.
- *What happens to our data if we leave?* You export it — employees, raw punches, daily records, summaries and the
  audit log — and we delete on a scheduled, audited job. {{Confirm export formats and notice period.}}

---

## 5. Full FAQ

Home page uses §1.12; this is the complete set for a dedicated page.

**Product**
- What exactly does FlowZa Time do? — Reuse the elevator paragraph in §0.
- Is this payroll? — §1.12.
- Can it handle night shifts that cross midnight? — Yes. An overnight shift is computed as one working day with a punch
  window that extends into the next calendar day, so a 22:00–06:00 shift produces one record, not two halves.
- Can different branches have different rules? — Yes. Rule sets resolve branch-first and are effective-dated, so a
  policy change applies from a date rather than retroactively rewriting closed months.
- Does it handle rotational shifts? — Yes, as patterns with a cycle and an anchor date, resolved per employee, team,
  department, branch or organisation.
- What about Ramadan? — §1.8.

**Devices**
- Which devices are supported? — §1.7, word for word. Do not improvise this answer.
- We have an old terminal. Will it work? — Tell us the model and firmware. If it speaks a protocol we have verified, it
  works; if it is a vendor on our roadmap, we will tell you where that vendor stands rather than guess.
- Do devices need a fixed IP or a VPN? — Depends on the connection method. Devices that push to us need outbound
  internet only. Devices we poll on your LAN need reachability into your network.
- What if the internet drops at a branch? — Terminals buffer punches locally and send them when they reconnect. We
  deduplicate on the way in.

**Data and security**
- Where is our data? — In an isolated tenant within our managed cloud, with row-level isolation at the database level.
  {{Confirm the hosting region before answering "where" more precisely.}}
- Do you store biometric data? — No. §1.9.
- Can FlowZa staff see our records? — Not by default, and not silently. §1.9.
- Can we delete data? — Retention is configurable per organisation and deletion runs as a scheduled, audited job.

**Getting started**
- How long does implementation take? — {{Fill from the first pilot. Do not publish a number before you have run one.}}
- Do you import our existing employees? — Yes, employees import in bulk and each gets a device identity, auto-numbered
  per vendor if you do not supply one.
- What training does HR need? — {{Fill from the pilot.}}
- Do you support Arabic? — Fully, interface and reports. §1.8.

---

## 6. About

**H1:** Built in the Gulf, for the way the Gulf actually works
**Body:**
> FlowZa Time is a product of F & Z Capital, launching in Oman and built for the GCC — where a single company runs five
> branches in three timezones' worth of habits, half the workforce reads Arabic, the working week does not start on
> Monday, and the terminals were bought over eight years from whoever had stock.
>
> We built the boring parts properly. Raw data is immutable. Calculations are deterministic and traced. Tenants are
> isolated by the database, not by a query someone might forget to write. We do not claim a device works until we have
> run it on hardware — which sometimes makes our compatibility list shorter than a competitor's, and always makes it
> true.

**Values block (three, no more):**
- **Say the specific thing.** Numbers with their working attached.
- **Verify before you claim.** An unverified integration is a roadmap item, not a feature.
- **Know where you stop.** We are attendance. Payroll is someone else's job, and we make their job easier.

---

## 7. Microcopy

**Primary navigation:** Product · Devices · Reports · Security · Pricing · About · {{عربي}}
**Product dropdown:** Attendance engine · Devices & sync · Shifts & rules · Corrections & approvals · Reports ·
Payroll hand-over · Security & roles

**Buttons:** Book a demo · See pricing · Talk to us · Watch the two-minute tour · Read the docs

**Footer columns**
- *Product:* Attendance engine · Devices · Reports · Security · Pricing
- *Company:* About · Contact · Careers {{if hiring}}
- *Legal:* Privacy policy · Terms of service · Data processing addendum · Sub-processors {{all required before launch}}
- *Bottom line:* © {{year}} F & Z Capital. FlowZa Time is a registered product of F & Z Capital. Muscat, Oman.

**Contact form:** "Tell us what you run — how many branches, roughly how many employees, and which terminals if you
know. We will come back with what we can verify today and what is scheduled."
**Form success:** "Thank you — we will reply within one working day." {{Only promise what support can meet.}}
**Newsletter:** "Occasional product notes. No more than monthly, and never a sales sequence."
**404:** "That page has clocked out. Try the product overview, or tell us what you were looking for."
**Cookie notice:** "We use cookies for the things that make the site work and to count visits. Nothing follows you
around." {{Match to what you actually install.}}

---

## 8. SEO metadata

Titles ≤ 60 characters, descriptions ≤ 155.

| Page | Title | Meta description |
|---|---|---|
| Home | FlowZa Time — Attendance & Time Management for the GCC | Connect attendance machines from many vendors to one cloud. Traceable daily attendance, Arabic and English, built for multi-branch GCC organisations. |
| Devices | Multi-Vendor Attendance Device Management \| FlowZa Time | One inventory, one sync engine and one health view for your whole terminal estate — whichever vendors you own. |
| Engine | The Attendance Engine \| FlowZa Time | Deterministic daily records with a full trace: punches, shift, rules and corrections behind every late minute and hour of overtime. |
| Reports | Attendance Reports & Exports \| FlowZa Time | Fourteen HR-ready layouts as CSV, XLSX or PDF — in English or Arabic, generated in the background and audited on download. |
| Security | Security & Tenant Isolation \| FlowZa Time | Row-level isolation, encrypted device credentials, no central biometric storage, and an immutable audit trail. |
| Pricing | Pricing \| FlowZa Time | Four plans by scale, from a 14-day trial to multi-country estates. Engine, reports and audit trail in every tier. |
| About | About FlowZa Time — F & Z Capital | Cloud attendance and workforce time management built in Oman for the GCC, by F & Z Capital. |

**Primary keywords:** attendance management system Oman · time attendance software GCC · biometric attendance software
Muscat · multi-branch attendance system · ZKTeco cloud attendance · نظام الحضور والانصراف عمان
**Open Graph image:** one line of copy over the brand green (`#0f6e56`), product screenshot beneath.
**Structured data:** `SoftwareApplication` with `applicationCategory: BusinessApplication`, plus `FAQPage` on the FAQ.
Do not add `AggregateRating` until you have real reviews.

---

## 9. The Arabic site

Not a translation pass. Rules:

- **Translate meaning, not words.** Rewrite headlines in Arabic rather than rendering the English literally; the hero
  especially.
- **Mirror the layout.** Navigation, hero, tables and forms all flip. The English site's left-aligned hero becomes
  right-aligned; do not centre everything to dodge the decision.
- **Type:** IBM Plex Sans Arabic, matching the product. Arabic needs a slightly larger size and looser line-height than
  the Latin setting at the same optical weight.
- **Keep LTR islands LTR.** Device model numbers, serials, timezones, email addresses, URLs.
- **Numbers and dates** follow the same regional settings the product uses. Pick Eastern or Western Arabic numerals once
  and stay consistent with the app.
- **The language switch is a first-class nav item**, not a flag icon in a corner. Label it in the target language:
  "عربي" on the English site, "English" on the Arabic one.
- **Have it read by a native Gulf Arabic speaker** before launch. Levantine or Egyptian phrasing in HR terminology
  reads as imported.

---

## 10. Claim ledger

What the website may say today, and what it rests on. Widening a row needs a code change, not a copy change.

| Claim on the site | Status | Evidence / limit |
|---|---|---|
| Multi-vendor device framework, one inventory, one sync view | ✅ Safe | Provider contract, registry, throttling and conformance suite are implemented and tested. |
| Attendance engine: late, OT, under-hours, half-day, missing punch, overnight, rotational, Ramadan | ✅ Safe | Pure domain code with a large unit-test suite; every rule listed here is implemented. |
| Full calculation trace; immutable raw data; void-only events; versioned records | ✅ Safe | Enforced by the data model. |
| Fourteen report layouts; CSV / XLSX / PDF; background generation; audited downloads; 7-day retention | ✅ Safe | All fourteen are registered and available. |
| Locked, versioned period summaries for payroll | ✅ Safe | Implemented. |
| Row-level isolation on every tenant table; migration fails without a policy | ✅ Safe | Enforced and covered by isolation tests. |
| Encrypted device credentials, key rotation, masked in UI | ✅ Safe | AES-256-GCM, device bound. |
| No central biometric template storage | ✅ Safe | Templates are discarded at ingestion; the feature flag is off. |
| Platform staff need a time-boxed, reason-bearing grant | ✅ Safe | Implemented and audited. |
| Immutable audit log incl. sensitive reads | ✅ Safe | Implemented. |
| Arabic / RTL interface and Arabic reports | ✅ Safe | Both implemented; the Arabic UI flag is on by default. |
| 44 permissions, custom roles, branch-scoped membership | ✅ Safe | Implemented. |
| MFA (TOTP), 12-character password policy, login history | ✅ Safe | Implemented. |
| Devices reach us by push, vendor cloud, vendor webhook or on-prem server | ✅ Safe *as architecture* | All four modes exist in the framework and the inbound HTTP endpoints are implemented. What varies is which vendor adapters are finished — see the next two rows. |
| **ZKTeco PUSH terminals** | ⚠️ **"Live in pilot", never "supported"** | The protocol handler is complete and tested, but has not yet been verified against hardware. It ships as beta. Do not name specific models as certified. |
| **Hikvision, Suprema, Anviz, eSSL, FingerTec, Matrix, NITGEN** | ❌ **Roadmap only** | Definitions exist; every operation refuses with `NOT_IMPLEMENTED`. The site must not list these as supported, and a logo wall of vendor marks would imply exactly that. |
| "500+ devices, 10,000+ employees" | ⚠️ Say **"designed for"** | A design target validated against a seeded 500-employee / 20-device organisation, not a measured production ceiling. |
| **Trial / self-service sign-up** | ⚠️ Depends on deployment | The application implements sign-up with organisation creation; the hosted project currently has sign-up disabled. Enable it before a "Start free" CTA goes live. |
| **Plan entitlements: advanced reports, SSO, outbound webhooks** | ❌ Not yet | Listed against plans in reference data, but their feature flags are off / 0% rollout and the report types are `planned`. Roadmap only. |
| **Public API and customer webhooks** | ❌ Not yet | The internal REST API exists; customer-facing API keys and outbound subscriptions are designed, not shipped. Do not advertise "open API". |
| **Employee self-service, mobile app, geofenced punches** | ❌ Not yet | The data model is ready; there is no employee-facing app. Roadmap only. |
| Uptime / SLA figures | ❌ Not yet | No production deployment history exists to support a number. |
| Customer names, counts, testimonials, "trusted by" | ❌ Not yet | No live customers to cite. Use capability statements until a customer agrees in writing. |

---

## 11. Do not say

These are wrong today. Each has a replacement that is true.

| Don't write | Write instead |
|---|---|
| "Supports Hikvision, Suprema, Anviz, ZKTeco and more" | "ZKTeco PUSH terminals are live in pilot. Hikvision, Suprema, Anviz, eSSL, FingerTec, Matrix and NITGEN are on the roadmap and ship once verified on hardware." |
| "Works with any attendance device" | "Built to take any vendor — each ships once we have run it." |
| "Trusted by 100+ companies in Oman" | "Launching in Oman with our first pilot customers." |
| "99.9% uptime guaranteed" | "Built on managed cloud infrastructure with health checks and audited operations." Add an SLA when you can meet one. |
| "Complete HR and payroll platform" | "Attendance and workforce time management, with a clean feed into your payroll system." |
| "Real-time attendance from anywhere" | "Punches arrive as devices deliver them; sync progress is visible live." |
| "Open REST API for integrations" | "Payroll-ready exports today; a customer-facing API is on the roadmap." |
| "Mobile app with GPS check-in" | Nothing. It does not exist. Do not put it on the site, not even greyed out with "coming soon" on the pricing table. |
| "Fully GDPR/PDPL compliant" | "Designed against Oman's PDPL, with UAE and Saudi requirements in scope." Only claim compliance once counsel signs it off. |
| "Bank-grade / military-grade encryption" | "Device credentials are encrypted with AES-256-GCM under rotatable keys." |
| "AI-powered attendance" | "A deterministic engine — the same inputs always produce the same record, and the working is attached." |

---

## 12. Build notes for whoever assembles the site

- **Brand green** `#0f6e56` (`brand-700`, primary action) with `#137a5d` and `#1f9873` for lighter steps and
  `#eefaf5` for tinted grounds. Sidebar/dark ground `#0e2b25`. Keep the site inside the product's palette so a demo
  does not look like a different company.
- **Type:** Inter for Latin, IBM Plex Sans Arabic for Arabic, JetBrains Mono for serials, codes and anything
  machine-shaped.
- **Elevation:** the product uses exactly one small card shadow and 12px radius on panels. A marketing site with heavy
  drop shadows and 24px pills will not feel like the same product.
- **Screenshots:** take them from the seeded demo organisation, never from a real customer, and check that no seeded
  name, national ID or serial is readable before publishing.
- **Every product claim on a page should map to a row in §10.** If it does not, it is not ready to publish.
