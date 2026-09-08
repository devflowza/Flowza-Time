# Go-live runbook

State of the deployment as this was written: the database is provisioned and migrated
(`liyilmbklsextsggflbb`, ap-south-1, Postgres 17), the web bundle is live on Cloudflare Pages, and **nothing else is
running**. The API and worker are not deployed, the database login roles have no passwords, no auth user exists and no
organisation exists. The steps below take it from there to a usable system.

**Do them in this order.** Each one is blocked by the one before it — in particular the API cannot be deployed before
the role passwords exist, because it has nothing to connect with.

Nothing in this file contains a secret. Every value written as `<…>` is generated or copied by the operator and stored
in the hosting platform's secret store, never in the repository.

---

## 0. Generate the application secrets

Two values are needed before anything is deployed, and **the API and worker must receive the identical
`FLOWZA_CREDENTIALS_MASTER_KEYS`** — the API encrypts device credentials with it and the worker decrypts them. A
mismatch means every device sync fails to authenticate.

```bash
# FLOWZA_CREDENTIALS_MASTER_KEYS — format is key_id:base64(32 bytes)
node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"

# FLOWZA_DEVICE_PUSH_SECRET — signs device push tokens and webhook challenges
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep an offline escrow copy of the master key. Losing it makes stored device credentials unrecoverable and they must be
re-entered per device; attendance data itself is unaffected (`docs/deployment.md` → Backups & disaster recovery).

---

## 1. Set the database role passwords

The migrations create `flowza_api` and `flowza_worker` as login roles with **no password**, so no one can connect as
them until you set one. Verified against the live project: `rolpassword is null` for both.

Prefer `psql` with `\password`, which hashes the value client-side so the plaintext never travels in a statement:

```
psql "postgresql://postgres:<db password>@<direct host>:5432/postgres"
\password flowza_api
\password flowza_worker
```

The Supabase SQL editor also works, but `alter role … password '…'` sends the plaintext and the editor keeps a
snippet history, so the password outlives the statement.

Confirm — note this must read **`pg_authid`**, not `pg_roles`. `pg_roles` masks the column as `********` for every
role, so `rolpassword is not null` there is true whatever the state and tells you nothing:

```sql
select rolname, rolpassword is not null as password_set
from pg_authid where rolname in ('flowza_api', 'flowza_worker');
-- both rows must read true
```

The end-to-end proof is still `/api/ready` returning 200 in step 2 — that is the only check that exercises the
password, the pooler URL and the role grants together.

### Building the connection strings

Copy the pooler hostname from **Dashboard → Connect** (it is region-specific; do not guess it). Two details are easy to
get wrong:

- **Supavisor rewrites the username to `<role>.<project-ref>`.** For this project that is
  `flowza_api.liyilmbklsextsggflbb` and `flowza_worker.liyilmbklsextsggflbb`, not the bare role name.
- **The two apps need different pooler modes.**

| Variable | Role | Port | Mode | Why |
|---|---|---|---|---|
| `DATABASE_URL_API` | `flowza_api` | 6543 | transaction | Many short web requests; transaction pooling scales them |
| `DATABASE_URL_WORKER` | `flowza_worker` | 5432 | session | The scheduler holds a **session-level advisory lock** for leader election. Transaction pooling hands the connection to another transaction and the lock is lost |

```
DATABASE_URL_API=postgresql://flowza_api.liyilmbklsextsggflbb:<pw>@<pooler-host>:6543/postgres
DATABASE_URL_WORKER=postgresql://flowza_worker.liyilmbklsextsggflbb:<pw>@<pooler-host>:5432/postgres
```

`DATABASE_URL_ADMIN` is **not** a runtime variable — it belongs to the migration tooling only, and the migrations are
already applied.

The role grants are already correct: `flowza_api` may `SET ROLE` to both `authenticated` and `flowza_system`, and
`flowza_worker` to `flowza_system` (verified — `set_option` is true on each membership). That is what lets a request run
under the caller's own RLS policies rather than with blanket privileges.

---

## 2. Deploy the API

The repository ships Fly.io configuration for both services: `fly.api.toml` and `fly.worker.toml` at the root, plus
`.github/workflows/deploy.yml` (manual dispatch — there is no staging environment, so every deploy reaches production).
Region is `bom` (Mumbai) to sit beside the `ap-south-1` Supabase project; a request makes several database round trips,
so the distance is paid multiple times per request.

```bash
flyctl apps create flowza-time-api
flyctl apps create flowza-time-worker
```

Build context is the **repository root** (the workspace is needed to resolve `@flowza/contracts`), Dockerfile is
`apps/api/Dockerfile`. It listens on **4000** and runs as a non-root user. `.dockerignore` keeps `node_modules`, git
history and the web build out of the ~370 MB that would otherwise upload to the builder on every deploy.

Environment:

```
NODE_ENV=production
LOG_LEVEL=info
SUPABASE_URL=https://liyilmbklsextsggflbb.supabase.co
SUPABASE_ANON_KEY=<publishable key>
DATABASE_URL_API=<from step 1>
DATABASE_POOL_MAX=10
FLOWZA_CREDENTIALS_MASTER_KEYS=<from step 0>
FLOWZA_DEVICE_PUSH_SECRET=<from step 0>
API_PUBLIC_URL=https://<api-host>
WEB_ORIGINS=https://time.flowza.ai
TRUST_PROXY=true
```

Non-secret values are already in `fly.api.toml`'s `[env]`. Set the rest as secrets, which never enter the repository:

```bash
flyctl secrets set --app flowza-time-api \
  DATABASE_URL_API='<from step 1>' \
  FLOWZA_CREDENTIALS_MASTER_KEYS='<from step 0>' \
  FLOWZA_DEVICE_PUSH_SECRET='<from step 0>'
```

Optional:

- `SUPABASE_SERVICE_ROLE_KEY` — used **only** for realtime broadcast and signed storage URLs, never for data access.
  Omit it and the API starts fine, logging `supabase_platform_clients_disabled`; live updates and signed file links are
  no-ops until it is set.
- `SUPABASE_JWT_SECRET` — only for legacy HS256 projects. Token verification tries the project JWKS first
  (`/auth/v1/.well-known/jwks.json`), which is what a project with asymmetric signing keys uses.

`WEB_ORIGINS` must be the exact browser origin, comma-separated for more than one. A mismatch shows up as a CORS
failure in the browser with the API logging nothing — the request never reaches a handler.

The canonical origin is the custom domain, `https://time.flowza.ai`. Deliberately **not** listed: the
`*.pages.dev` deployment URLs. Every Cloudflare preview build gets its own hostname, so allowing them either means an
unmaintainable list or a wildcard that lets any preview talk to production data. If you want previews to work, point
them at a separate staging API rather than widening this one.

### Lock the origin to Cloudflare — required, not hardening

`fly.api.toml` sets `CLIENT_IP_HEADER=cf-connecting-ip` and `TRUSTED_PROXY_HOPS=2`. **Both settings assume the request
actually came through Cloudflare**, and neither survives an origin that can be reached directly:

- `CF-Connecting-IP` is authoritative only because Cloudflare overwrites it. Nothing overwrites it on a direct request.
- The hop count is correct only because two proxies appended to `X-Forwarded-For`. A direct request has one fewer hop,
  so counting two in from the right lands on a **client-supplied** entry.

So closing the origin is the precondition the client-IP handling rests on, not a second layer over it.

**Authenticated Origin Pulls is not the answer here.** Cloudflare's own panel says as much — it requires the origin to
validate a client certificate, and the Fly proxy does not do that on the application's behalf. The Global tier is
worse than useless for this: it is zone-wide (so it also covers `time.flowza.ai` and every other proxied record) and
presents a certificate shared across all Cloudflare customers, so with no origin-side validation it changes nothing
while reading as "on".

Two options that do work:

| | Effort | Strength |
|---|---|---|
| **`EDGE_SHARED_SECRET`** — Cloudflare Transform Rule adds `x-flowza-edge: <secret>`; the API refuses requests without it | minutes | Defeats anyone who has guessed the origin hostname but cannot read the secret |
| **Cloudflare Tunnel** — `cloudflared` alongside the app, no public listener at all | a deploy change | Removes direct reachability entirely |

Start with the shared secret and treat the tunnel as the end state. Generate the value, set it on the Fly app
(`flyctl secrets set --app flowza-time-api EDGE_SHARED_SECRET='…'`), then add the matching Cloudflare Transform Rule
for `time-api.flowza.ai` and `time-push.flowza.ai`. `/api/health` stays open so the platform's own health check still reaches
the container; `/api/ready` is gated because it reports database latency and queue depth.

Leave `EDGE_SHARED_SECRET` unset and the gate is inert — correct for local development, and honest about the fact that
such a deployment has an open origin.

**Verify before going further:**

```bash
curl -s https://<api-host>/api/health          # {"status":"ok","service":"flowza-api",...}
curl -i -s https://<api-host>/api/ready        # 200 + "status":"ready"
```

`/api/ready` returns **503 `degraded`** when it cannot reach the database or the job queue. That is the check that
proves step 1 was done correctly — do not move on while it is red.

---

## 3. Deploy the worker

Same repository-root build context, `apps/worker/Dockerfile`, configured by `fly.worker.toml`. No inbound port; it is
a queue consumer, so the config declares no `[http_service]` at all.

```bash
flyctl secrets set --app flowza-time-worker \
  DATABASE_URL_WORKER='<from step 1 — the SESSION pooler, port 5432>' \
  FLOWZA_CREDENTIALS_MASTER_KEYS='<byte-identical to the API's>'
```

```
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL_WORKER=<from step 1, session pooler>
DATABASE_POOL_MAX=10
FLOWZA_CREDENTIALS_MASTER_KEYS=<identical to the API's>
WORKER_CONCURRENCY=8
WORKER_QUEUES=sync,processing,reports,notifications,maintenance
WORKER_PER_ORG_CONCURRENCY=5
SCHEDULER_ENABLED=true
API_PUBLIC_URL=https://<api-host>
WEB_PUBLIC_URL=https://time.flowza.ai
EMAIL_PROVIDER=console
```

Run **two or more instances** for availability. Leave `SCHEDULER_ENABLED=true` on all of them: the scheduler leader is
elected with a Postgres advisory lock, so exactly one instance ticks and the others take over if it dies.

Email stays on `console` (logged, not sent) until you set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM`.
Notifications are written to the outbox either way, so nothing is lost by starting on `console`.

**This is a separate path from Supabase's auth email** (§5c) and the two are easy to confuse. Supabase sends
confirmation, password-reset and magic-link mail through its own SMTP settings; this variable only governs the
worker's own notifications — device offline, report ready, and so on. Invited users receive their *account*
confirmation via Supabase regardless of what `EMAIL_PROVIDER` is set to, and the invitation link itself is delivered by
the administrator copying it out of the UI. Nothing writes invitations to the outbox.

Confirm from the API side after a minute: `/api/ready` reports queue depth, and it should not be climbing with nothing
draining it.

---

## 3b. Deploy the reports worker (PDF reports)

PDF reports render in headless Chromium, which the general worker is deliberately built without (512 MB, device sync must
never be starved). A second Fly app runs the same image with Chromium and the Noto fonts, consuming only the `reports`
queue. Until it exists, CSV/XLSX reports work from the general worker and PDF requests fail with "PDF rendering is not
available on this worker". See `docs/reports.md` and the comments in `fly.reports.toml`.

```bash
flyctl apps create flowza-time-reports --org <your fly org>          # once
# same secrets as the general worker, minus RESEND_API_KEY (this worker sends no mail)
flyctl secrets set --app flowza-time-reports   DATABASE_URL_WORKER='...' FLOWZA_CREDENTIALS_MASTER_KEYS='...' SUPABASE_URL='...' SUPABASE_SERVICE_ROLE_KEY='...'
flyctl deploy --config fly.reports.toml --remote-only --ha=false
flyctl logs --app flowza-time-reports    # expect worker_started with queues: ["reports"]
```

Then remove `reports` from `WORKER_QUEUES` in `fly.worker.toml` and redeploy the general worker, so the two apps do not
compete for the same jobs. Verify: request a PDF report from Reports → it reaches COMPLETED and downloads.

## 4. Point the web app at the API

`VITE_*` values are inlined **at build time**, so this needs a rebuild, not a restart.

In **Cloudflare Pages → Settings → Environment variables → Production**, add:

```
VITE_API_URL=https://<api-host>
```

Then redeploy. Host variables override the committed `apps/web/.env.production`, so the Cloudflare value wins once it
is set — and setting it there is the better end state than editing the file.

**Origin only.** The client builds `${VITE_API_URL}/api/v1/<path>`, so a trailing slash or an included `/api` produces
doubled paths and 404s.

Verify by opening the site and watching the network tab: requests should go to `https://<api-host>/api/v1/...` and come
back 200 or 401 — not fail to connect, and not be blocked by CORS.

### TLS certificates on Fly — required before Cloudflare can reach the origin

A proxied Cloudflare CNAME does **not** hide the original hostname from the origin. Cloudflare connects sending SNI and
Host of `time-api.flowza.ai`, not of the CNAME target, and Fly routes by SNI and only serves certificates for hostnames it
has issued. Without a certificate for the custom hostname the TLS handshake fails outright — a 525/526 at the edge,
whatever the SSL mode is set to.

```bash
flyctl certs add time-api.flowza.ai  --app flowza-time-api
flyctl certs add time-push.flowza.ai --app flowza-time-api
flyctl certs show time-api.flowza.ai --app flowza-time-api   # until it reads Ready
```

Because the DNS records are proxied, Fly cannot use HTTP-01 validation — the challenge never reaches the origin. Use
the DNS-01 `_acme-challenge` CNAMEs that `flyctl certs add` prints, and **leave them in place permanently**: renewal
uses them too, and deleting them turns into an outage ninety days later rather than immediately.

A Cloudflare **Origin Rule** overriding SNI and Host to `flowza-time-api.fly.dev` is a valid alternative that needs no
Fly certificates, and it is safe for this application specifically — nothing here reads the `Host` header, and the one
absolute URL the API builds (the device push URL, `devices.service.ts`) comes from `API_PUBLIC_URL`, not from the
request. It relies on the SNI override field being available on the plan, and it leaves a rewritten Host for a future
reader to trip over, so prefer the certificates unless you have a reason not to.

### Forcing HTTPS when the zone cannot

`time-push.flowza.ai` must accept plain HTTP, and Cloudflare's "Always Use HTTPS" is zone-wide with no per-hostname
override — so the zone switch stays off and every other hostname in it is served over HTTP too if asked. For the web
app that means the bundle in the clear; for the API it means bearer tokens in the clear on the browser-to-Cloudflare
leg.

Close it per hostname instead, which is also how this zone already handles it (there is an existing redirect rule of
this shape for `finance.flowza.ai`):

- A **Redirect Rule** matching hostname `time.flowza.ai` or `time-api.flowza.ai` with scheme `http`, to the same URI over
  `https`, 301. Do not include `time-push.flowza.ai`.
- `apps/web/public/_headers` sends `Strict-Transport-Security` for the web app, so after one HTTPS visit a browser
  will not use HTTP for that host again. It binds only the host that sends it, so it cannot reach the push hostname.

### Hostnames

> **`flowza.ai` is a shared Cloudflare zone, and the Cloudflare and Supabase accounts host other FlowZa applications**
> (Finance, PMS, Club, Sign, SpaManager, LogisPro, RentFlow, QR). Two consequences run through this whole runbook:
>
> - **Every name this application claims must be `time`-prefixed.** A generic `api.flowza.ai` would take the obvious
>   name away from eight other applications and make the zone impossible to reason about.
> - **Some Cloudflare settings are zone-wide, not per-hostname** — SSL/TLS encryption mode and "Always Use HTTPS" both
>   are. Changing either affects every other application on the zone, so check the current value before touching it and
>   prefer per-hostname Redirect, Transform and Origin Rules. Where this document names a rule, it is hostname-scoped
>   on purpose.
>
> **On the encryption mode specifically: leave it at `Full`, which is what the zone is set to.** Full already encrypts
> the Cloudflare→Fly leg, which is all this application needs. Do **not** raise it to `Full (strict)` for this
> application's benefit: the gap strict would close — proving the origin's identity — is the same gap
> `EDGE_SHARED_SECRET` closes per-hostname, and the zone carries `cpanel` / `webmail` / `whm` / `autoconfig` A records
> pointing at a shared cPanel host whose certificate may not survive strict validation. Raising it would risk taking
> mail and cPanel down to harden one application that does not need it.
>
> Supabase is not affected: this application has its own project (`liyilmbklsextsggflbb`), so Auth settings, the
> password policy, MFA configuration and the database roles are all scoped to it alone. There is no `pg_cron` here
> either — scheduled work is the worker's own leader-elected scheduler, private to its Fly app.

The web app is served from the custom domain **`https://time.flowza.ai`**. Three other names are worth deciding on
together rather than one at a time, because two of them appear in configuration that is awkward to change later:

| Name | Serves | Notes |
|---|---|---|
| `time.flowza.ai` | the web app | live |
| `time-api.flowza.ai` (suggested) | `apps/api` | goes in `API_PUBLIC_URL` and `VITE_API_URL` |
| `time-push.flowza.ai` (suggested) | device push ingress | **must accept plain HTTP on port 80** — see below |

Device push is the constraint that shapes the choice. Legacy ZKTeco/eSSL/FingerTec firmware speaks plain HTTP to
`/iclock/*` and cannot do TLS, so that hostname needs an HTTP listener restricted to `/device-push/*` and `/iclock/*`
and rate-limited per source IP and serial, with everything else redirected to HTTPS
(`docs/deployment.md` → Device push ingress). Do not put that on the same hostname as the web app or the API.

A device's push URL is written into its firmware during commissioning, so changing `time-push.flowza.ai` later means
physically revisiting every terminal. Pick it once.

---

## 5. Configure the Auth URLs, then register the auth hook

### 5a. Auth URL configuration

Supabase Auth builds the links in password-reset and invitation emails from its own configuration, not from where the
request came from. Left at its default a reset email sends the user to `localhost`, so this must be set before anyone
relies on password recovery.

**Dashboard → Authentication → URL Configuration:**

| Field | Value |
|---|---|
| Site URL | `https://time.flowza.ai` |
| Redirect URLs | `https://time.flowza.ai/auth/reset`, `https://time.flowza.ai/auth/callback`, `https://time.flowza.ai/auth/invite**` |

`/auth/invite**` is what makes invited-owner onboarding work: the acceptance page passes
`emailRedirectTo: invitationUrl(token)` so the confirmation email returns the invitee to the exact link they started
from. Without it Supabase falls back to the Site URL and drops a freshly confirmed invitee on the dashboard holding no
membership — the one screen that cannot help them.

Add `http://localhost:5173/**` to the redirect list as well if developers need password reset to work locally.

The web app calls `resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/reset` })`, so the
origin it sends is whatever host the browser is on. Supabase rejects any `redirectTo` that is not on the allow list and
silently falls back to the Site URL, which looks like "the reset link goes to the wrong page" rather than an error.

### 5b. The password verification hook

`app.on_password_verification_attempt(jsonb)` exists in the database and is already granted to `supabase_auth_admin`,
but Supabase Auth does not call it until it is registered.

**Dashboard → Authentication → Hooks → Password Verification Attempt** → type *Postgres*, schema `app`, function
`on_password_verification_attempt`.

It records every success and failure in `public.login_history` and stamps `user_profiles.last_login_at`. It is
deliberately fail-open — any error inside it returns `{"decision":"continue"}` so a logging problem can never lock
anyone out of the product.

Verify after the first sign-in (step 6):

```sql
select event, occurred_at, details from public.login_history order by occurred_at desc limit 5;
```

An empty table after a successful sign-in means the hook is not registered. Note that `login_history.user_id`
references `user_profiles`, so rows only appear for users that already have a profile row — which step 6 creates.

### 5c. Custom SMTP — required before anyone can be invited

Supabase's built-in email sender is rate-limited to a handful of messages an hour and is not intended for production.
Until custom SMTP is configured, `signUp` creates the account but the confirmation email never arrives, so an invited
owner **cannot complete onboarding at all**. Configuring it raises the auth email limit to 30/hour.

Sending is via **Resend on its own subdomain**, `time.flowza.ai`, deliberately not the root domain and not the
`send.flowza.ai` that other FlowZa applications use:

- The root carries Microsoft 365 business mail — `MX → flowza-ai.mail.protection.outlook.com` and a hard-fail SPF,
  `v=spf1 include:spf.protection.outlook.com -all`. Adding a sender to that record risks the company's own email.
  A subdomain needs no change to it at all.
- A shared sending domain means one application's reputation is every application's reputation.

Add the domain in Resend (Manual setup, **not** Auto configure — the latter asks for OAuth write access to the whole
Cloudflare zone, which hosts every other FlowZa application). Then add exactly three records:

| Type | Name | Content |
|---|---|---|
| TXT | `resend._domainkey.time` | the DKIM public key Resend shows |
| TXT | `send.time` | `v=spf1 include:amazonses.com ~all` |
| MX (10) | `send.time` | `feedback-smtp.<region>.amazonses.com` |

Skip the inbound MX Resend offers on `time.flowza.ai` itself: it is for *receiving* mail, which this application does
not do, and it would collide with the proxied CNAME that serves the web app.

Create a key scoped to **Sending access on `time.flowza.ai` only** (`flowza-time-prd-sending`), so a leak cannot send
as another application's domain. Resend will not let a key be scoped to a domain until that domain is verified — wait
for verification rather than creating an all-domains key.

**Dashboard → Authentication → Emails → SMTP Settings:**

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` — a literal, **not** the sender name |
| Password | the Resend API key |
| Sender email | `no-reply@time.flowza.ai` |
| Sender name | `FlowZa Time` |

The username trips people up: it is always the literal string `resend`. Putting anything else there — the sender name
is the easy mistake — fails with `535 "Invalid username"`, which reads like a password problem and is not.

Verify by triggering a real send and reading the auth log, rather than trusting the form:

```bash
curl -i -X POST 'https://<project-ref>.supabase.co/auth/v1/recover' \
  -H 'apikey: <publishable key>' -H 'Content-Type: application/json' \
  -d '{"email":"<an existing user>"}'
# 200 = sent. 500 with x-sb-error-code: unexpected_failure = SMTP refused; the reason is in the auth logs:
#   select log_attributes['error'] from logs where source='auth_logs' and log_attributes['path']='/recover'
```

Then confirm **Delivered** in Resend → Emails, and that Resend → API keys shows the *expected* key as recently used.
A domain-scoped key that sent successfully is itself proof the From domain and DKIM signature were the intended ones.

---

## 6. Create the platform super admin (dev@flowza.ai)

Two facts shape this step: `platform_admins.user_id` → `user_profiles.id` → `auth.users.id`, and the API only creates
the `user_profiles` row lazily on the first `GET /api/v1/me`. So the auth user comes first, then the profile, then the
admin row — which is what `seed:platform-admin` does in one idempotent pass:

```bash
DATABASE_URL_ADMIN='postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres' \
SUPABASE_URL='https://<ref>.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='<service role key>' \
PLATFORM_ADMIN_PASSWORD='<the super admin password>' \
  pnpm --filter @flowza/database run seed:platform-admin -- --email dev@flowza.ai --level owner
```

The password is read from the environment, never from `argv`, because command lines are visible to every process on
the host — keep it out of your shell history too (a leading space, or `read -rs`). It is checked against the project
policy in `supabase/config.toml` (≥12 characters, mixed classes) before anything is written, so a password hosted Auth
would refuse fails here with a clear message instead of a 422. Options: `--email` (default `dev@flowza.ai`),
`--level` (`support` | `admin` | `owner`, default `owner`), `--name`.

With `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set, the auth user is created or updated through the Supabase Auth
admin API — the only supported way to write `auth.users` on a hosted project. Without them the tool writes
`auth.users` directly and therefore **refuses any non-loopback database**, which is the local-development path
(§ docs/development.md). Re-running rotates the password and re-asserts the level; it never duplicates rows, and every
run appends a `platform_admin.seeded` entry to `audit.logs`.

Confirm:

```sql
select p.email, a.level, a.status
from public.platform_admins a join public.user_profiles p on p.id = a.user_id;
-- dev@flowza.ai | owner | active
```

**Then enrol MFA — the account cannot be used before that.** `requireAuth` rejects every request from a platform
admin whose session is below `aal2` (`apps/api/src/middleware/auth.ts`), so with no verified TOTP factor even
`GET /api/v1/me` returns `403 FORBIDDEN` / `MFA_REQUIRED`. Sign in to the web app: it answers that response with a
blocking enrolment screen (scan the QR code, enter the 6-digit code) rather than the normal shell, because there is
no page a platform admin could reach before the session carries `aal2`. Enrolment talks to Supabase Auth directly,
so it needs no API call. Verify:

```sql
select count(*) from auth.mfa_factors f
join public.platform_admins a on a.user_id = f.user_id
where f.status = 'verified';
```

**What this does and does not grant.** A platform admin can manage organisations, plans, feature flags and access
grants. It does **not** grant access to any tenant's attendance data. Reading a customer's rows requires a
time-boxed `platform_access_grants` row — capped at 72 hours, and a `write` grant additionally requires a second
approver recorded in `approved_by`. That separation is intentional; do not work around it by querying as `postgres`.

---

## 7. Create the first organisation

Organisations are created through the platform API, not by hand — the endpoint also creates the settings row, the
subscription, the owner membership and the audit entry in one transaction.

Sign in to the web app as `dev@flowza.ai`, copy the access token, then:

```bash
curl -X POST https://<api-host>/api/v1/platform/orgs \
  -H "Authorization: Bearer <access token>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "companyCode": "FLOWZA",
    "legalName": "F & Z Capital LLC",
    "displayName": "F & Z Capital",
    "countryCode": "OM",
    "timezone": "Asia/Muscat",
    "currencyCode": "OMR",
    "locale": "en",
    "weeklyOffDays": [5, 6],
    "ownerEmail": "dev@flowza.ai",
    "ownerFullName": "FlowZa Platform Owner",
    "planKey": "trial"
  }'
```

- `planKey` is one of `trial`, `starter`, `business`, `enterprise`. `trial` sets the organisation to `trial` status
  with a 14-day subscription; anything else starts `active`.
- `companyCode` is unique and case-insensitive, 2–32 characters of `A–Z a–z 0–9 _ -`.
- Because `dev@flowza.ai` now has a `user_profiles` row, the **owner membership is created immediately** (system role
  `owner`, all branches) and `invitation` comes back `null`.
- For an owner email that has never signed in, the response instead carries a one-time invitation token. **It is
  returned once and only its hash is stored** — capture it from the response, or the invitation has to be reissued.
- `Idempotency-Key` is optional but worth sending: a retried POST replays the first response instead of creating a
  second organisation. The store is per-instance, so with more than one API instance behind a load balancer this
  guarantee holds only when the retry lands on the same one.

Sign out and back in so the new membership is in the session, and the workspace loads with the organisation selected.

---

## What is still not done after all of this

- **Device integrations are unproven against real hardware.** The provider implementations and the ZKTeco push path
  are covered by tests against protocol doubles, not a physical terminal. Treat the first device onboarding as a
  commissioning exercise, not a configuration step.
- **Zero-touch device claiming trusts knowledge of the serial number** (`docs/risks.md` D26) — an open design item, not
  an oversight.
- **Auth email sends** (§5c): Supabase custom SMTP via Resend on `time.flowza.ai`, verified end to end — confirmation,
  password reset and magic links reach the inbox. The **worker's own** notification email is still on `console`, so
  device-offline and report-ready messages are logged and not sent until `EMAIL_PROVIDER=resend` and `RESEND_API_KEY`
  are set on `flowza-time-worker`.
- **No invitation email is sent by the application.** The invitation link is delivered by the administrator copying it
  out of the UI. Automating it needs a dedicated queued job: the outbox relay routes by *permission within an
  organisation*, which cannot address someone who is not a member yet, and the plaintext token must not be written to
  `jobs.payload` given only its hash is stored.
- **Realtime and signed storage URLs are inert** until `SUPABASE_SERVICE_ROLE_KEY` is set on the API and worker.
- **Nothing is monitored.** `/api/ready` is the intended uptime check; logs are structured JSON ready for a drain
  (`docs/observability.md`).
