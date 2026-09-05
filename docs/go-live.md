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
for `api.flowza.ai` and `push.flowza.ai`. `/api/health` stays open so the platform's own health check still reaches
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
Invitations and notifications are written to the outbox either way, so nothing is lost by starting on `console` — but
an invited user will not receive their email.

Confirm from the API side after a minute: `/api/ready` reports queue depth, and it should not be climbing with nothing
draining it.

---

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
Host of `api.flowza.ai`, not of the CNAME target, and Fly routes by SNI and only serves certificates for hostnames it
has issued. Without a certificate for the custom hostname the TLS handshake fails outright — a 525/526 at the edge,
whatever the SSL mode is set to.

```bash
flyctl certs add api.flowza.ai  --app flowza-time-api
flyctl certs add push.flowza.ai --app flowza-time-api
flyctl certs show api.flowza.ai --app flowza-time-api   # until it reads Ready
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

`push.flowza.ai` must accept plain HTTP, and Cloudflare's "Always Use HTTPS" is zone-wide with no per-hostname
override — so the zone switch stays off and every other hostname in it is served over HTTP too if asked. For the web
app that means the bundle in the clear; for the API it means bearer tokens in the clear on the browser-to-Cloudflare
leg.

Close it per hostname instead, which is also how this zone already handles it (there is an existing redirect rule of
this shape for `finance.flowza.ai`):

- A **Redirect Rule** matching hostname `time.flowza.ai` or `api.flowza.ai` with scheme `http`, to the same URI over
  `https`, 301. Do not include `push.flowza.ai`.
- `apps/web/public/_headers` sends `Strict-Transport-Security` for the web app, so after one HTTPS visit a browser
  will not use HTTP for that host again. It binds only the host that sends it, so it cannot reach the push hostname.

### Hostnames

The web app is served from the custom domain **`https://time.flowza.ai`**. Three other names are worth deciding on
together rather than one at a time, because two of them appear in configuration that is awkward to change later:

| Name | Serves | Notes |
|---|---|---|
| `time.flowza.ai` | the web app | live |
| `api.flowza.ai` (suggested) | `apps/api` | goes in `API_PUBLIC_URL` and `VITE_API_URL` |
| `push.flowza.ai` (suggested) | device push ingress | **must accept plain HTTP on port 80** — see below |

Device push is the constraint that shapes the choice. Legacy ZKTeco/eSSL/FingerTec firmware speaks plain HTTP to
`/iclock/*` and cannot do TLS, so that hostname needs an HTTP listener restricted to `/device-push/*` and `/iclock/*`
and rate-limited per source IP and serial, with everything else redirected to HTTPS
(`docs/deployment.md` → Device push ingress). Do not put that on the same hostname as the web app or the API.

A device's push URL is written into its firmware during commissioning, so changing `push.flowza.ai` later means
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
| Redirect URLs | `https://time.flowza.ai/auth/reset`, `https://time.flowza.ai/auth/callback` |

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

---

## 6. Create the platform super admin (dev@flowza.ai)

Two facts shape this step: `platform_admins.user_id` → `user_profiles.id` → `auth.users.id`, and the API only creates
the `user_profiles` row lazily on the first `GET /api/v1/me`. So the auth user comes first, then the profile, then the
admin row.

**a. Create the auth user.** Dashboard → **Authentication → Users → Add user**: email `dev@flowza.ai`, a strong
password, **auto-confirm enabled**. (Or send an invite and set the password from the email.)

**b. Promote to platform owner**, in the SQL editor:

```sql
insert into public.user_profiles (id, email, full_name)
select id, email, 'FlowZa Platform Owner'
from auth.users where email = 'dev@flowza.ai'
on conflict (id) do nothing;

insert into public.platform_admins (user_id, level, status)
select id, 'owner', 'active'
from public.user_profiles where email = 'dev@flowza.ai'
on conflict (user_id) do update set level = 'owner', status = 'active';
```

Confirm:

```sql
select p.email, a.level, a.status
from public.platform_admins a join public.user_profiles p on p.id = a.user_id;
-- dev@flowza.ai | owner | active
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
- **Email is not sending** until `EMAIL_PROVIDER=resend` is configured.
- **Realtime and signed storage URLs are inert** until `SUPABASE_SERVICE_ROLE_KEY` is set on the API and worker.
- **Nothing is monitored.** `/api/ready` is the intended uptime check; logs are structured JSON ready for a drain
  (`docs/observability.md`).
