# On-prem edition — deployment and device connectivity plan

**Status:** Proposed · **Date:** 2026-10-21

The customer runs FlowZa Time on its own server at headquarters. No cloud, and no device traffic over the public internet.
Headquarters uses IDEMIA Morpho terminals; remote sites may use Morpho or other brands, and some remote sites may have no
internet at all. This document is the plan for that deployment: the network design, the Morpho connector, and the work
FlowZa still has to do. It does not change the SaaS deployment (`docs/deployment.md`).

## 1. Decision in one paragraph

Every terminal talks **only to private addresses at HQ**: the FlowZa server, or MorphoManager for Morpho terminals. Remote
sites join the HQ private network in one of three tiers: the company WAN, a site-to-site VPN router, or a 4G VPN router.
Only a site with no link at all falls back to USB collection. Morpho is integrated **once**, through MorphoManager, not
terminal by terminal. Other brands use the providers FlowZa already has, pointed at the HQ server's private address.
A software "site agent" is not built unless a customer forbids VPN routers.

## 2. Network design

```
                        HEADQUARTERS (customer server room)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  FlowZa server (Linux VM, Docker)                                          │
 │    nginx  :443 web + API (customer CA cert)   :80 /iclock/* only          │
 │    api · worker ×2 · Postgres 16 · self-hosted Supabase (Auth, Storage,   │
 │    Realtime) · NTP server for all terminals · SMTP relay → customer mail  │
 │                                                                            │
 │  MorphoManager server ──LAN── Morpho terminals (HQ)                       │
 │         └── export folder (read-only share) ──► FlowZa worker             │
 │  Other HQ terminals ──LAN──► FlowZa server (push) / ◄── worker (pull)     │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │  private network only (HQ firewall)
   ┌─────────────┼───────────────────────┬────────────────────────────────┐
   │ Tier 1      │ Tier 2                │ Tier 3a              │ Tier 3b  │
   │ Company WAN │ Site has internet     │ Site has no line     │ Nothing  │
   │ (MPLS,      │ → VPN router          │ → 4G router with VPN │ → USB    │
   │ leased line)│ (IPsec / WireGuard)   │ (or operator APN)    │ export   │
   │ nothing to  │ to the HQ firewall    │ to the HQ firewall   │ uploaded │
   │ install     │                       │                      │ at HQ    │
   └─────────────┴───────────────────────┴──────────────────────┴──────────┘
```

| Tier | Site situation | What goes on site | Internet used? | Data delay |
|---|---|---|---|---|
| 1 | Already on the company WAN | Nothing. Terminals get the HQ server IP and NTP address. | No | Real time (push) / ≤ 5 min (pull) |
| 2 | Has an internet line, no WAN | One small VPN router (site-to-site IPsec or WireGuard to the HQ firewall). | Only as an encrypted carrier. Terminals are never exposed, and HQ opens only the VPN port, never FlowZa itself. | Real time / ≤ 5 min |
| 3a | No line at all | 4G/LTE router with the same VPN (or a mobile operator's private APN where offered). Attendance is a few hundred KB per day. | Mobile carrier only, encrypted | Real time / ≤ 5 min |
| 3b | No link possible | Nothing. Terminals keep their logs; someone downloads them to USB on a schedule and uploads the file at HQ. | No | Until the next upload |

Why a VPN router, not FlowZa software on site:
- Terminals keep their **native protocol**, so every brand works the same way at a remote site as at HQ, including
  MorphoManager reaching remote Morpho terminals.
- No PC to patch at each site. The router is standard network equipment that customer IT already knows how to run.
- Terminals buffer punches while the link is down (thousands to millions of records, depending on model). When the tunnel
  comes back, push devices resend and pull adapters resume from their cursor; the dedupe hash makes replays harmless.

### Rules that apply to every site

- **Clock:** every terminal syncs to the NTP server at HQ (no internet NTP). The device time zone is set per branch in
  FlowZa. Punches with too much clock skew are quarantined automatically (existing behaviour).
- **Direction:** prefer **push-capable** terminals at remote sites (ZKTeco/eSSL ADMS, Hikvision HTTP listening). The site
  only needs to reach HQ, which works behind NAT and survives link drops. Pull devices also need HQ to reach the site.
- **Addressing:** each site gets its own subnet. FlowZa may only call device subnets listed in its configuration (§5.2).
- **Employee IDs:** the user ID on every terminal and in MorphoManager equals the FlowZa employee's device user ID.
  Without this, punches land as "unknown employee".

## 3. Morpho (IDEMIA)

| Path | Verdict |
|---|---|
| **MorphoManager** (IDEMIA's Windows server software; HQ already uses it to enrol users) | **Chosen.** It already collects logs from every Morpho terminal it can reach (default every 5 minutes), and it has an automatic time-and-attendance export intended for payroll packages. One integration covers all Morpho terminals at HQ and at tier 1–3a sites. |
| Terminal SDK (SIGMA, MorphoWave, VisionPass; the "SDK"-type integrations access-control vendors use) | **Not planned.** No public third-party protocol was found; it needs IDEMIA's SDK under a partner agreement. |

Verification level: `REPORTED_SECONDARY`. Both MorphoManager facts come from excerpts of the MorphoManager user manual and
from distributor pages; the manual itself was not opened. The export **format is unknown** until we receive a sample from
the customer's installation, and nothing will be built against a guessed format.

Connector design (`idemia_morphomanager`, `ON_PREM_SERVER_API`, starts as `beta`):
- MorphoManager writes its automatic access-log export into a folder. That folder is shared **read-only** with the FlowZa
  server. The worker reads new files on the normal sync schedule. FlowZa never deletes or edits them.
- Cursor = processed files plus the last line read; the dedupe hash protects against re-exports and overlapping files.
- File access goes through a small injected file-source port, so tests run on fixtures and the provider never touches the
  filesystem directly.
- Capabilities: attendance pull **only**. Enrolment, biometrics and user deletion stay in MorphoManager (FlowZa stores no
  biometric templates). A termination therefore cannot enqueue `DELETE_EMPLOYEE` for Morpho. Instead FlowZa raises a
  task: "remove from MorphoManager".
- Fallback if the export proves unreliable: a read-only SQL Server login to the MorphoManager database. This would need an
  MSSQL driver, which is a new dependency.
- It stays `beta` until it has been run against the customer's MorphoManager and the result is recorded in
  `docs/device-integrations.md` §7.

## 4. Other brands at remote sites

All of these exist today. On-prem they point at the HQ server's private address instead of a public hostname.

| Brand / product | FlowZa provider | Direction | Status today |
|---|---|---|---|
| ZKTeco, eSSL, FingerTec (ADMS firmware) | `zkteco_push`, `essl_push`, `fingertec_push` | Terminal → `http://<flowza-ip>/iclock/*` (nginx rewrite, `docs/api.md`) | beta, not yet run on hardware |
| Hikvision access terminals | `hikvision_push` | Terminal → FlowZa (HTTP listening) | available (run on a real terminal) |
| Hikvision ISAPI | `hikvision_isapi` | Worker → terminal | beta |
| Suprema BioStar 2 server | `suprema_biostar2` | Worker → server | beta |
| ZKBio Time server | `zkteco_biotime` | Worker → server | beta |
| Matrix COSEC | `matrix_cosec` | Worker → terminal | beta |
| Anviz CrossChex **Cloud**, Hik-Partner Pro | — | Vendor cloud | **Not usable on-prem** (internet only). Hidden by feature flag. |

## 5. What FlowZa has to build

### 5.1 On-prem package
- `deploy/onprem/docker-compose.yml`: Postgres 16, self-hosted Supabase services the code uses today (Auth/GoTrue for
  login and session revocation, Storage for reports and files, Realtime for live screens), `api`, `worker` ×2, nginx
  serving `apps/web/dist` plus the API and push paths. The API already verifies HS256 tokens (`SUPABASE_JWT_SECRET`),
  which is how self-hosted GoTrue signs by default.
- Realtime can be left out at first: the sync and live-attendance screens already poll as their baseline and treat
  realtime only as a faster refresh signal. Confirm every other realtime consumer before dropping the service.
- Email: add `EMAIL_PROVIDER=smtp` for the customer's mail server (today only `console` and `resend`, a cloud service).
  This likely needs an SMTP library, which is a new dependency.
- No cloud services: Resend webhooks off, Sentry off, logs to file/syslog for the customer's monitoring.
- Offline install and upgrades: an image bundle (`docker save`) plus migrations (`packages/database` migrate tool), and an
  offline licence file. Nothing pulls from the internet at runtime.
- Backups: nightly `pg_dump` and Storage copy to the customer's NAS; a restore drill is part of go-live.

### 5.2 Private device network (security change)
Today `FLOWZA_ALLOW_PRIVATE_EGRESS` is a development switch that opens **every** private address and plain HTTP. On-prem
needs a narrow version instead:
- `DEVICE_EGRESS_ALLOWED_CIDRS` (on-prem only): the device and MorphoManager subnets. Everything else stays blocked,
  including loopback, the FlowZa server's own subnet and the database.
- LAN terminals often have self-signed certificates. Use **per-device certificate pinning**: the admin confirms the
  fingerprint on first connection, and a later change fails as an error. TLS verification is never switched off.
- Plain HTTP only per device, only inside an allowed subnet, and only when an admin ticks it (audited).
- Tests for each rule in `egress.test.ts` / `vendor-http.test.ts`.

### 5.3 Morpho connector
§3, plus reference data migration, feature flag, wizard fields and en/ar strings.

### 5.4 Offline sites (tier 3b only)
- **Punch file import:** upload a terminal's USB export (or a MorphoManager export file) at HQ. It runs as a queued job and
  stores rows with `source = 'IMPORT'`, which already exists in `RAW_SOURCES` but has no endpoint yet. The dedupe hash makes
  re-uploads safe. Formats per brand, from real samples.
- **Site agent** (store-and-forward software on a mini PC): **deferred.** Build it only if a customer refuses VPN routers.
  It would reuse the push handlers locally and forward to HQ over HTTPS.

## 6. Phases

| Phase | Owner | Content | Exit criterion |
|---|---|---|---|
| 0 | Customer + FlowZa | Site survey: per site, tier, brand/model, subnet; MorphoManager version and one export sample; who runs the VPN. | Filled site table, sample file received |
| 1 | FlowZa | On-prem package (§5.1) and private device network (§5.2) | Clean install on a test VM with no internet; HQ push terminal punches arrive |
| 2 | FlowZa | Morpho connector (§3) | HQ Morpho punches arrive through MorphoManager on the customer's system; recorded in §7 of `device-integrations.md` |
| 3 | Customer IT, FlowZa support | Tier 1/2/3a sites: VPN router template, per-brand setup sheet (server IP, port, NTP, time zone) | Each site's terminals online in FlowZa; offline alerts tested by pulling the link |
| 4 | FlowZa | Only if needed: punch file import (§5.4); site agent only on demand | Tier 3b site's USB file imported without duplicates |

## 7. Open questions for the customer

1. MorphoManager version, and is its time-and-attendance export already enabled? One sample file, with names and IDs replaced.
2. Morpho terminal models (SIGMA / SIGMA Lite, MorphoWave, VisionPass, MA500…).
3. Per remote site: company WAN, internet line, or nothing? Who manages the HQ firewall and VPN?
4. Brands and models at the remote sites, and whether new purchases can be push-capable.
5. Server for FlowZa: VM or physical, OS, and whether HQ has an internal certificate authority and an SMTP relay.
