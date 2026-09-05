# Device Integrations — vendor due diligence, compatibility matrix and implementation status

> **Read this before promising any customer that FlowZa "supports" a device.**
> Rule §135 (AGENTS.md rule 4): never claim support that has not been verified. Placeholder providers throw
> `ProviderError('NOT_IMPLEMENTED')`; they never fake success. This document is the single place where the gap
> between *what vendors offer*, *what we have researched* and *what this repository actually does* is written down.

Companion documents: `docs/blueprint.md` §E (integration architecture), §F (sync), §L (adding a vendor);
`docs/adr/ADR-003-device-provider-abstraction.md`; provider contract in `packages/device-providers/src/types.ts`;
reference data in `supabase/migrations/20260905001600_reference_data.sql`.

Research inputs: eight vendor due-diligence files (Hikvision, ZKTeco, Anviz, Suprema, eSSL, Matrix, NITGEN, FingerTec)
produced in September 2026. **Important caveat inherited from that research:** the research sandbox's egress proxy blocked
almost every official vendor domain (hikvision.com, zkteco.com, anviz.com, esslsecurity.com, matrixcomsec.com, nitgen.com,
fingertec.com, supremainc.com support). Most claims below therefore rest on open-source implementations and search-engine
excerpts, and only a handful of official documents were actually opened. Every claim carries its verification level.

## 0. Legends

### Verification levels (research vocabulary, used per claim)

| Level | Meaning |
|---|---|
| `VERIFIED_OFFICIAL_DOC` | An official vendor document was opened and the claim was read from it. |
| `REPORTED_SECONDARY` | Consistent across independent open-source implementations and/or search excerpts of official docs; the official page itself was not opened. |
| `UNKNOWN` | No usable evidence found either way. |

### Verification status (repository vocabulary, `device_providers.verification_status`)

`VERIFIED` / `REPORTED` / `UNVERIFIED` (`@flowza/contracts` `VERIFICATION_STATUSES`). In this repository `VERIFIED` is
**stricter** than the research level: it means *FlowZa engineering ran the adapter against a live device or server and
recorded the result in §7 of this document*. Reading an official manual is necessary but not sufficient. That is why
`zkteco_biotime` and `suprema_biostar2` stay `REPORTED` even though their research level is `VERIFIED_OFFICIAL_DOC`.

### Provider status (`device_providers.status`)

`available` (production), `beta` (works end to end in tests, awaiting hardware verification), `placeholder`
(definition only; every operation throws `NOT_IMPLEMENTED`), `deprecated`.

---

## 1. Connectivity modes and how they map to FlowZa components

Blueprint §E.1 defines the modes; `@flowza/contracts` `INTEGRATION_TYPES` = `VENDOR_CLOUD_PULL`, `VENDOR_WEBHOOK`,
`DEVICE_PUSH`, `ON_PREM_SERVER_API`, `LAN`. The attendance engine never sees any of them: every mode ends in
`ingestRawTransactions(orgId, deviceId, RawTransaction[])` (idempotent; dedupe hash when the vendor gives no transaction id).

| Mode | Who initiates | FlowZa component that owns it | Cursor / idempotency | Credentials |
|---|---|---|---|---|
| `VENDOR_CLOUD_PULL` | Worker polls vendor cloud | `apps/worker` sync handler → `provider.pullAttendance(ctx, cursor)`; `sync_cursors` (jsonb, provider-defined) | Vendor record id when available (`providerTransactionId`), otherwise dedupe hash | `DeviceCredentialsStore` (system context), decrypted in memory for the call only |
| `VENDOR_WEBHOOK` | Vendor cloud POSTs events | `apps/api` `/webhooks/providers/:providerKey` → `provider.handleWebhook(req, secrets)` → job queue → ingest | `WebhookHandlingResult.eventId` for replay protection; `signatureValid` recorded | Webhook secret from `device_credentials` |
| `DEVICE_PUSH` | Device POSTs to FlowZa and polls FlowZa for commands | `apps/api` `/device-push/:protocolKey/*` → `registry.pushProtocol(key)` (`identifyDevice` → `parseInbound` → enqueue → `renderCommands`); commands persisted in `device_commands` | Protocol stamps (e.g. ZKTeco `ATTLOGStamp`) persisted by the route and fed back via `DevicePushParseContext.stamps`; dedupe hash because the device has no record id | Device serial allow-listed per tenant; per-device secret only where the protocol has one |
| `ON_PREM_SERVER_API` | Worker calls a customer-hosted server (BioStar 2, ZKBio Time, COSEC CENTRA …) | `apps/worker` → provider adapter; customer exposes HTTPS/VPN; optional future connector agent | Server record id (BioStar `id`, BioTime `id`) or time window + id | Server login stored in `device_credentials` |
| `LAN` | Worker (or future agent) calls the device itself | Same as above; requires reachability into the customer network | Device event serial where present (Hikvision `serialNo`, COSEC `seq-No`) | Device admin credentials |

Design consequences that apply to every mode:

- **Async by default** (rule 5). Anything touching a device returns `{ jobId, status: 'QUEUED' }`. For `DEVICE_PUSH`
  providers even "synchronous-looking" operations (`upsertEmployee`, `deleteEmployee`, `restart`) return
  `DeviceOperationResult.async = true` with the protocol commands in `details.commands`; the device picks them up on its
  next poll.
- **Throttling** is provider-declared (`ProviderThrottling`: `maxConcurrentPerDevice`, `maxConcurrentPerAccount`,
  `requestsPerMinute`) and enforced by the worker through `ctx.acquire()` (`packages/device-providers/src/throttle.ts`).
- **Push endpoints must never block the device.** Parse, enqueue, answer the protocol's expected `OK`; all heavy work
  happens in the worker. Push-protocol handlers throw `ProtocolError` (never retryable, carries the HTTP status to return).
- **Biometric templates are not stored by default.** The ZKTeco handler discards `FP`/`FACE`/`BIOPHOTO`/`BIODATA` lines
  on purpose; `biometricTemplatePush` is `false` everywhere except two placeholders, and the `biometric_template_sync`
  feature flag is off pending legal review.
- **Time.** Devices usually report local time without offset. Handlers use `parseDeviceTime(value, ctx.timezone)`
  (Luxon, device IANA zone) and store UTC; the original string is kept in `deviceLocalTime`.

---

## 2. Vendor sections

Each section lists the integration paths found, the verification level per path, the research's recommended first
integration and what still needs hardware or credentials. Doc URLs are copied from the research files; **no endpoint
named here was invented by FlowZa** — where the research says a detail is unknown, it is unknown.

### 2.1 ZKTeco

Dominant T&A brand in Oman/GCC (Startech ME, AIMS, Ainaan Networks, Zayn Technology in Oman; Endless Data in UAE; regional office
zkteco.me in Dubai). Regional firmware variants exist: a captured handshake in the wild sent `DeviceType='middle east'`.

| Path | Type | Auth | Attendance | Employee push | Biometric sync | Events / webhooks | Cloud / partner requirements | Verification |
|---|---|---|---|---|---|---|---|---|
| PUSH / ADMS protocol (`/iclock/*`) | `DEVICE_PUSH_PROTOCOL` | None in push v2 — device identified by `SN` query param; push v3 reportedly adds RegistryCode/SessionID + MD5 token and optional AES/RSA (`Encrypt`) — not verified | Device POSTs `table=ATTLOG` tab-separated rows (`PIN, time, status, verify, workcode…`); `ATTLOGStamp` returned in the handshake is the de-facto cursor; `DATA QUERY ATTLOG` for replay (community) | Yes: `DATA UPDATE USERINFO …` / `DATA DELETE USERINFO PIN=` / `DATA QUERY USERINFO` via `getrequest`; results on `/iclock/devicecmd` | Reported: `DATA UPDATE FINGERTMP` (v2) / `biodata` / `biophoto` (v3); templates also arrive in OPERLOG; cross-family portability UNKNOWN | Inherent (Realtime=1); heartbeat = `getrequest`; no payload signature | Device needs outbound HTTP/HTTPS to FlowZa (COMM > Cloud Server Setting); no licence to *receive* pushes; official PUSH SDK PDF is confidential and reportedly paid/quote-based via ZKTeco ME or distributors | `REPORTED_SECONDARY` |
| ZKBio Time / BioTime REST API | `ON_PREM_SERVER_API` | `POST /jwt-api-token-auth/` → `Authorization: JWT <token>` (or `/api-token-auth/` → `Token <token>`) — verified in BioTime 8.0 manual; 9.x requires an API licence (reported) | `GET /iclock/api/transactions/?start_time=&end_time=&page=&limit=`; stable `id` per row (use as `providerTransactionId`); sliding window + id de-dup | `POST/PATCH/DELETE /personnel/api/employees/`; devices via `/iclock/api/terminals/` | No template endpoint in the 8.0/8.5 manual; 9.0 UNKNOWN | None documented — polling only | Customer must expose the server (public IP/reverse proxy/VPN); ZKBio Time licence sized by devices/employees; API licence on 9.x | `VERIFIED_OFFICIAL_DOC` (8.0 manual) |
| ZKBio CVSecurity 3rd-party API | `ON_PREM_SERVER_API` | `?access_token=<apitoken>` query param; API Authorization menu appears only after API licence activation | `/api/transaction/listAttTransaction?pageNo=&pageSize=`, `/api/v2/transaction/list`, `/api/transaction/monitor` (poll) | `POST /api/person/add`, `DELETE /api/person/delete/{pin}`, `/api/attAreaPerson/set` | Fingerprint: `POST /api/bioTemplate/add`; face template endpoint not verified | None (monitor is pull) | Customer buys the CVSecurity API licence module | `VERIFIED_OFFICIAL_DOC` (v1.1 manual) |
| ZKBio Zlink (Minerva IoT) cloud | `VENDOR_CLOUD_API` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | Devices bound to Zlink cannot simultaneously push to FlowZa (single Cloud Server setting) | `UNKNOWN` |
| ZKBio CloudAccess (legacy) | `VENDOR_CLOUD_API` | UNKNOWN — no API documentation anywhere | — | — | — | — | Do not build against it | `UNKNOWN` |
| Standalone / Pull SDK (TCP/UDP 4370) | `LAN_SDK` | Optional numeric comm key | Pull full log; realtime events while connected | Yes (`CMD_USER_WRQ`) | Fingerprint templates yes; face incomplete | Only while a LAN agent holds the session | Free, published by ZKTeco on GitHub; needs a LAN agent | `VERIFIED_OFFICIAL_DOC` (existence/free status); protocol details `REPORTED_SECONDARY` |

Doc URLs (from research): PUSH — https://github.com/s0x90/zkteco-adms , https://github.com/syofyanzuhad/filament-zkteco-adms ,
https://github.com/saifulcoder/adms-server-ZKTeco , https://github.com/ecosoft-frappe/thai_zkt , https://github.com/Upeosoft-Limited/zkteco_http_listener ;
BioTime 8.0 API manual — https://s3.ap-southeast-1.amazonaws.com/zkteco.co.th/files/20230917/BioTime%208.0%20API%20User%20Manual-20200615.pdf ;
CVSecurity API manual — https://s3.ap-southeast-1.amazonaws.com/zkteco.co.th/files/20240807/ZKBio_CVSecurity_3rd_Party_API_User_Manual_V1.1_20240521.pdf ;
Standalone SDK — https://github.com/ZKTeco/Standalone-SDK , https://github.com/adrobinoga/zk-protocol/blob/master/protocol.md .
Blocked official pages to open first: https://www.zkteco.com/en/PUSHSDK , https://www.zkteco.com/en/ADMS , https://www.zkteco.me/download-file/2051 .

**Recommended first integration: PUSH/ADMS receiver (`zkteco_push`).** It is the only path where the device talks
directly to FlowZa with no customer server, licence or LAN agent; it is real-time; it covers the terminals actually sold
in Oman (K40/F22/MB360/uFace/SpeedFace/SenseFace ship with ADMS firmware); and it is the same mechanism ZKBio Time and
Zlink use, so a device can simply be repointed at FlowZa. Second: `zkteco_biotime` for customers already running
ZKBio Time / BioTime 9.5 with many devices (fully documented, low risk, but needs a reachable server and an API licence
on 9.x). Defer Zlink/CloudAccess until ZKTeco ME grants developer-portal access.

**Needs hardware / credentials to verify**

- Exact handshake/response contract per firmware (`options=all` keys, `ServerVer`/`PushProtVer`, push v2 vs v3
  `/registry` flow, `RegistryCode`/`SessionID`, `Encrypt` AES/RSA) — needs the official PUSH SDK PDF plus one v2 and one v3 device.
- HTTPS to a public-CA endpoint on GCC-sold units: TLS versions/ciphers, SNI, redirects; behaviour of `DeviceType=middle east` firmware.
- ATTLOG `workcode`/reserved fields; `Stamp` resync after outages (duplicate/replay behaviour) to finalise the idempotency hash.
- `DATA UPDATE USERINFO` limits: name length, Arabic rendering, privilege codes, card formats, `devicecmd` return codes.
- Template push (`FINGERTMP`/`biodata`/`biophoto`): accepted algorithm versions, base64 format, cross-model portability, contractual permission.
- ZKBio Time 9.x: are the 8.0 endpoints unchanged, is the API licence mandatory, does `area[]` auto-sync to devices, any new template/command endpoints.
- Zlink/Minerva IoT open API existence; CloudAccess/ZKBio Time Cloud API existence.
- Official ADMS/push compatibility matrix for units stocked by Oman distributors; which legacy units need the ADMS firmware upgrade (`ZK-TW-FW-UP`).
- Pricing/NDA terms for the PUSH SDK documentation and the ZKBio Time API licence in the GCC channel.

### 2.2 Hikvision

MENA HQ in Dubai; Oman distributors ATESCO, Technoxen, Hyvision. Regionally advertised models: MinMoe DS-K1T343 (Value, incl.
-MWX/-MFWX), DS-K1T341/342, DS-K1T671 (Pro), DS-K1A8503 fingerprint T&A. Typically installed by security integrators, so the
installer — not the customer — often controls the Hik-Partner Pro site.

| Path | Type | Auth | Attendance | Employee push | Biometric sync | Events / webhooks | Cloud / partner requirements | Verification |
|---|---|---|---|---|---|---|---|---|
| ISAPI (device HTTP API) | `LAN_DEVICE_API` | HTTP Digest with a device user; HTTPS usually self-signed; lockout after repeated failures (reported); Digest is clock-drift sensitive | `POST /ISAPI/AccessControl/AcsEvent?format=json` with `AcsEventCond {searchID, searchResultPosition, maxResults, major=5, startTime, endTime}`; `serialNo` per device is the natural cursor/idempotency key; ~30 records/page reported | `UserInfo/Record` (create), `UserInfo/Modify`, `UserInfo/Delete`, `UserInfo/Search`, `UserInfo/Count`; keyed by `employeeNo` | Face: `POST /ISAPI/Intelligent/FDLib/FaceDataRecord?format=json` (JPEG ≤200 KB, device builds template); fingerprint: `FingerPrintDownload` / `FingerPrintUpload`; card via `UserInfo/CardInfo` | `PUT /ISAPI/Event/notification/httpHosts/1` makes the device POST `AccessControllerEvent` JSON to a URL (no HMAC documented); `alertStream` long-lived multipart (needs inbound reach) | No licence/partner programme to call ISAPI on a device you own; official docs on tpp.hikvision.com need a free Hik account/TPP registration (some historically NDA); needs inbound reachability to the device for pull/CRUD | `REPORTED_SECONDARY` |
| Hik-Partner Pro OpenAPI (`/api/hpcgw/v1/...`) | `VENDOR_CLOUD_API` | API key → `POST /api/hpcgw/v1/token/get`; token valid 7 days; regional domains — GCC region UNKNOWN | UNKNOWN in detail (raw access data retrieval claimed; pull vs callback-only unconfirmed) | `person/add`, `person/update`, `person/delete` (guide excerpts) | UNKNOWN | Event subscription/callback advertised; payload UNKNOWN | **YES** — TPP registration; API key applied for offline via Hikvision regional office; accounts are for installers/partners | `REPORTED_SECONDARY` |
| Hik-Connect / Hik-Connect for Teams OpenAPI (`/api/hccgw/...`) | `VENDOR_CLOUD_API` | appKey/secretKey issued by Hikvision support; `Token` header | UNKNOWN in detail | Claimed, UNKNOWN in detail | Claimed, UNKNOWN in detail | UNKNOWN | AK/SK application with a Hik-Connect Team account; GCC data region UNKNOWN | `REPORTED_SECONDARY` |
| HikCentral Professional OpenAPI (Artemis, `/artemis/api/...`) | `ON_PREM_SERVER_API` | AppKey/AppSecret; HMAC-SHA256 headers `X-Ca-Key`, `X-Ca-Signature`, `X-Ca-Timestamp` | Pull (pageNo/pageSize convention, reported) + event subscription callback; `POST /artemis/api/attendance/v1/report` named in excerpt | Person add/update/delete + "apply to device" | Face/fingerprint/card via HCP | `eventSubscriptionByEventTypes` callback (reported) | Customer owns HCP with OpenAPI + Attendance licences | `REPORTED_SECONDARY` |
| ISUP 5.0 (EHome) + ISUP SDK | `DEVICE_PUSH_PROTOCOL` | Device ID + ISUP key; TLS optional (reported) | Device pushes access events to an SDK-hosted server; ISAPI passthrough over ISUP reported | Reported via passthrough; unverified for third parties | UNKNOWN | Native SDK callbacks (no HTTP) — needs a C/C++ gateway service | **YES** — B2B SDK under TPP/NDA; device needs outbound TCP (default 7660) to a FlowZa-hosted gateway | `REPORTED_SECONDARY` |
| HCNetSDK (native LAN SDK) | `LAN_SDK` | `NET_DVR_Login_V40` | `NET_DVR_GET_ACS_EVENT` + alarm callbacks | Reported | Reported | Native only | Hik account for download; LAN agent required | `REPORTED_SECONDARY` |

Doc URLs (from research): ISAPI — https://github.com/uchkunr/hikvision-best-practices , https://github.com/MAGNAT12/hikvision-isapi-python ,
https://github.com/Shaykhnazar/hikvision-isapi , https://github.com/idstein/hikvision_access ; HPP/HCC/HCP — https://github.com/pergolafabio/Hikvision-Addons/issues/282 ;
ISUP — https://github.com/stefan-golinschi/Hikvision-ISUP5.0-SDK , https://github.com/135356/hikvision_isup ; HCNetSDK — https://github.com/Sanguis102/hikvision-sdk-python/blob/main/HCNetSDK.py .
Blocked official pages to open first: the tpp.hikvision.com ISAPI wiki pages (AcsEvent, JSON_AcsEventCond, UserInfo/Search, FingerPrint*, EventNotificationAlert, alertStream — GUIDs listed in the research file),
https://tpp.hikvision.com/products/HPP-Integration , https://tpp.hikvision.com/solutions/TimeAttendance-Integration , https://api.hik-partner.com/ .

**Recommended first integration: ISAPI (`hikvision_isapi`) in hybrid mode** — (a) device-initiated push via `httpHosts`
to a per-device FlowZa ingest URL (org/device-scoped secret in the path, allow-listed serial, treated as an untrusted hint
because there is no HMAC), plus (b) authoritative incremental pull via `AcsEvent` keyed on (device serial, `serialNo`), run
from the worker or an optional LAN agent when the terminal is not reachable from the cloud. Reasons: no partner agreement,
licence, NDA or native SDK; covers the MinMoe/K1A families Oman distributors sell; provides the full capability set; can be
validated in days with one bench terminal. In parallel start the commercial process for the Hik-Partner Pro cloud-attendance
API key (true cloud-to-cloud path) and evaluate ISUP 5.0 as phase 2.

**Needs hardware / credentials to verify**

- Everything: register on tpp.hikvision.com and open the ISAPI Access Control wiki pages and the HPP/HCP developer guides.
- On a real DS-K1T343 / DS-K1T671 / DS-K1A8503: accepted `AcsEventCond` fields, page cap (30?), `searchID` stability, `serialNo`
  monotonicity across reboot, event buffer capacity, `time` timezone semantics, `attendanceStatus` population in T&A mode.
- `httpHosts` push: JSON support per firmware, public-CA HTTPS, retry when FlowZa is down, disabling pictures, multiple hosts.
- `UserInfo/Record`, `FaceDataRecord`, `FingerPrintDownload`: exact schema per firmware, Arabic (UTF-8) names, image constraints,
  template portability across models, `subStatusCode` list.
- Concurrency: simultaneous digest sessions per terminal, lockout thresholds, safe polling interval for 500 devices/org.
- Hik-Partner Pro: obtain API key via Hikvision MENA, confirm GCC region/data residency, token lifetime, pull-vs-callback, callback signature, rate limits,
  whether an end customer can authorise a third-party SaaS without an installer account.
- Hik-Connect (Teams) AK/SK; HCP licensed install for Artemis validation; ISUP SDK partner agreement and legal terms for multi-tenant hosting.
- Which SKUs/regional firmware ATESCO / Technoxen / Hyvision actually stock.

### 2.3 Suprema

Established GCC channel (ScreenCheck ME, Stebilex, TACS, ID Vision; Oman-local Tecneek). Installed base is on-prem BioStar 2
(2.8/2.9) / BioStar X on Windows LANs managing BioStation 2/2a/3, FaceStation 2/F2, BioEntry W2/W3. BioStar Air (cloud) previewed
at Intersec Dubai 2026 but hosted only in Korea/Germany.

| Path | Type | Auth | Attendance | Employee push | Biometric sync | Events / webhooks | Cloud / partner requirements | Verification |
|---|---|---|---|---|---|---|---|---|
| BioStar 2 / BioStar X REST API | `ON_PREM_SERVER_API` | `POST /api/login {"User":{"login_id","password"}}` → header `bs-session-id` on every call; HTTPS; session ~1 h (reported) | `POST /api/events/search` with `Query.conditions` (`datetime` BETWEEN, `id` GREATER lastId), ordered by `id` → stable `providerTransactionId`; rows carry `tna_key`; logs lag DB by ~3–10 s | `POST /api/users` (bulk <30 recommended), `PUT /api/users/:id`, `DELETE /api/users?id=`, `POST /api/users/export` (to devices), `POST /api/devices/sync` | `PUT /api/users/:id` with `fingerprint_templates[]` (from `/api/devices/:id/scan_fingerprint`), `credentials.faces[]`, `credentials.visualFaces[]` — Suprema-proprietary blobs | No HTTP webhooks; WebSocket stream from the server (reported); poll | Customer exposes BioStar HTTPS (self-signed cert common); no partner programme; whether a paid server tier is needed is UNKNOWN; TA module NOT required for raw events | `VERIFIED_OFFICIAL_DOC` (official BioStar X Postman collection) |
| G-SDK device gateway, `DEVICE_TO_SERVER` | `DEVICE_PUSH_PROTOCOL` | gRPC over TLS 1.2 to the gateway; device link AES256 (optional TLS); `SetAcceptFilter` allow-list; master gateway = mTLS + JWT | `Event.GetLog(deviceID, startEventID, max)` — monotonic event ID cursor; `Event.SubscribeRealtimeLog` stream; `TNA.GetTNALog` | `User.Enroll/EnrollMulti/Update/Delete…`, `SetCard`, limits: userID ≤32 B, name ≤48, 8 cards, 10 fingers, 5 faces | `User.SetFinger/SetFace`, `Finger.Scan`, `Face.Normalize/Extract`; IR vs RGB face templates not interchangeable | Native gRPC streaming (no HTTP webhooks) | FlowZa hosts the gateway binary on a public address (device outbound TCP 51212/51213); downloads via Suprema Download Center (login) since Mar 2026; licence file next to `device_gateway`; master gateway needs a commercial licence; device can't also be managed by BioStar | `VERIFIED_OFFICIAL_DOC` (g-sdk docs) |
| BioStar Air Cloud API | `VENDOR_CLOUD_API` | `POST {base}/login` → JWT Bearer; `getSelfAccounts` → `loginAccount`; bases `sp-api.airfob.com/v1` (live), `sp-a-api` (global), `sp-e-api` (EU); developer portal approval required | UNKNOWN specifics — event/attendance endpoint not documented in pages opened | `getUsers`, `createUser`, `updateUser`, `suspendUsers` (names only) | Not documented via API | UNKNOWN (marketed, not documented) | Developer-portal approval; VAR partner portal; only `-AIR` firmware devices; hosting KR/DE only; AWS API Gateway rate limits (numbers not published) | `VERIFIED_OFFICIAL_DOC` (auth/user pages only) |
| BioStar 2 Device SDK (native LAN) | `LAN_SDK` | Device connection; optional SSL | `BS2_GetLog` by event ID + callbacks (reported) | Reported | Reported | Callbacks | Download Center; superseded by G-SDK — do not implement | `REPORTED_SECONDARY` |
| BioStar 2 TA API (port 3002, `/tna/...`) | `ON_PREM_SERVER_API` | UNKNOWN | Punch-log search (reported) | n/a | n/a | None | BioStar 2 TA licence; not needed for FlowZa | `REPORTED_SECONDARY` |

Doc URLs (from research): BioStar X Postman collection — https://raw.githubusercontent.com/supremainc/docs/main/static/specs/bsxapi-postman-collection.json ,
https://github.com/supremainc/docs/tree/main/static/specs ; G-SDK — https://github.com/supremainc/g-sdk (docs/_apis: connect, network, event, user, finger, face, tna, device, login, tenant, connectMaster, server; docs/_tutorials/quick/gateway/config.md; docs/_tutorials/node/sync.md);
BioStar Air — https://github.com/supremainc/docs/blob/main/docs/platform/biostar_air/api-authentication.mdx , …/api-user-management.mdx , …/integration-quickstart.mdx , …/security-overview.mdx , …/site-setup-networking.mdx ;
Device SDK — https://github.com/supremainc/BioStar2_device_SDK , https://github.com/supremainc/deviceSDK_sample .

**Recommended first integration: BioStar 2 / BioStar X REST API (`suprema_biostar2`).** Matches the installed base in Oman;
fully verifiable today from the official Postman collection; pure HTTPS polling with a stable event id cursor and `tna_key` for
direction; no Suprema account, SDK or hosted binaries. Gate it with: customer-exposed HTTPS (allow-listed FlowZa egress),
self-signed-cert handling, a dedicated low-privilege operator, `limit ≤ 1000`, concurrency 1–2 per server, re-login on 401.
Second: G-SDK `DEVICE_TO_SERVER` with a FlowZa-hosted gateway for greenfield standalone terminals. Third: BioStar Air once a
developer account is approved and event/webhook endpoints are confirmed to exist.

**Needs hardware / credentials to verify**

- `/api/events/search`: `id GREATER` cursor at scale, max practical `limit`, exact row schema (`event_type_id.code`, `user_id.user_id`, `tna_key`) on 2.9.x vs X.
- Whether API access needs a paid server tier; operator permissions for `events/search` and `users/export`.
- WebSocket real-time stream: endpoint, auth, message format (support articles were blocked).
- Self-signed cert behaviour, session timeout/renewal, `use_allow_simultaneous_connection` under polling.
- G-SDK: Download Center terms, gateway OS/containerisation, `LICENSE_AGREEMENT.txt`, master-gateway pricing; real device over public internet
  (NAT, TLS 51213, DNS `serverURL`, reconnect, accept filter); event-id continuity after reboot/log wrap; per-gateway capacity.
- Face template compatibility across IR (FaceStation 2) and RGB (F2/BioStation 3/W3) fleets; fingerprint format constraints.
- BioStar Air: developer approval, existence of event-log/webhook endpoints, API key + JWT combination, numeric rate limits, GCC availability of `-AIR` devices.

### 2.4 Anviz

Second-tier in GCC (S4S Solutions and Future IT in Oman; ID Vision in Dubai). Regional products: VF30/VF30 Pro, W2 Pro, C2 Pro,
FaceDeep 3/5, M5 Plus. CrossChex Cloud regions are us/eu/ap only — no Middle East region.

| Path | Type | Auth | Attendance | Employee push | Biometric sync | Events / webhooks | Cloud / partner requirements | Verification |
|---|---|---|---|---|---|---|---|---|
| CrossChex Cloud Open API (`api.{us,eu,ap}.crosschexcloud.com`) | `VENDOR_CLOUD_API` | `api_key` + `api_secret` (customer enables developer mode) → token; all calls POST with envelope `{header:{nameSpace,nameAction,version,requestId,timestamp}, authorize:{type:'token',token}, payload}`; `authorize.token`/`token` | `attendance.record`/`getrecord` with `begin_time`, `end_time`, optional `workno`; 100-record cap observed, official paging UNKNOWN; no record id confirmed | UNKNOWN — employee endpoints mentioned in community threads, not confirmed | UNKNOWN via API | Webhooks feature pushes attendance to a customer HTTPS URL (Anviz staff posts); signature/retry UNKNOWN | Device connected to CrossChex Cloud (outbound HTTPS); 1 admin + 1 device free then per-device licences (reported); no partner programme; API PDF distributed via community/support | `REPORTED_SECONDARY` |
| CrossChex Cloud Webhooks | `WEBHOOK` | UNKNOWN (possibly URL-only) — treat as untrusted, reconcile via pull | Pushed per event/batch; payload mirrors `getrecord` items (`checktime`, `employee.workno`) | n/a | n/a | Attendance events only (as reported) | Same as above; FlowZa needs a public HTTPS endpoint | `REPORTED_SECONDARY` |
| AnvizCloudKit (device→server SOAP) | `DEVICE_PUSH_PROTOCOL` | Device username/password + vendor "open key" for production | Device pushes to a PHP SOAP server (WSDL in kit) | Implied by README, specifics UNKNOWN | UNKNOWN | Inherent | Old PHP kit, plain HTTP; production key from Anviz | `REPORTED_SECONDARY` |
| TC-B TCP protocol / Device SDK V2 (port 5010) | `LAN_DEVICE_API` | Device ID / optional password; plaintext (CVE-2019-11523/12393) | Download all/new records; realtime over TCP | Yes (libraries) | Fingerprint yes; face unimplemented | TCP realtime only | LAN agent required | `REPORTED_SECONDARY` |
| CrossChex Standard (desktop) DB | `ON_PREM_SERVER_API` | DB credentials | Direct DB reads (schema UNKNOWN) | UI only | UI only | None | Not recommended | `UNKNOWN` |

Doc URLs (from research): https://raw.githubusercontent.com/ApicalNomad/CrosschexAPI/main/crosschex_cloud_api.py , https://github.com/ApicalNomad/CrosschexAPI ,
https://github.com/YourFellow1/crossChexCloudApp ; AnvizCloudKit — https://github.com/anvizjacobs/AnvizCloudKit ; TC-B — https://github.com/MxLabs/Anviz , https://github.com/WhiteaglePT/node-anviz ,
https://github.com/raphael-dudek/anviz-protocol-php . Blocked official pages to open first: community.anviz.com threads #726, #1139, #2079, #491 and
https://help.anviz.com/hc/en-us/articles/25236851461017-Which-Models-Support-CrossChex-Cloud-System .

**Recommended first integration: CrossChex Cloud (`anviz_crosschex_cloud`) as a hybrid** — webhooks for near-real-time
ingestion plus `getrecord` time-window pull for reconciliation, per-org `api_key`/`api_secret` + region stored encrypted.
Only cloud-to-cloud path, self-enabled by the customer, covers every current Anviz model in GCC. **Register capabilities
honestly:** `attendancePull=true`, `webhooks=true`, `employeePush` disabled until the official API definition confirms it,
fingerprint/face push `false`, device status UNKNOWN. Defer TC-B and AnvizCloudKit.

**Needs hardware / credentials to verify**

- Obtain the official API definition (community posts #1139/#726/#2079); nothing is `VERIFIED_OFFICIAL_DOC` yet.
- Create an eu or ap account, enable developer mode; confirm key issuance, token lifetime (`payload.expires`), refresh needs.
- Full `nameSpace`/`nameAction` catalogue (employee, device, department); whether records include a unique id, device serial, verify mode, direction.
- Pagination parameters on `getrecord`; webhook payloads, signature, retry/backoff, ordering, duplicates; rate limits/429 behaviour at 500 devices.
- Whether API-created employees propagate to devices; regional server recommendation for Oman; physical test (W2 Pro or FaceDeep 3) for connectivity/backfill.
- AnvizCloudKit "cloud development mode" on current firmware and the production open-key process; TC-B availability on Linux-platform face terminals.

### 2.5 eSSL

eSSL terminals are rebranded ZKTeco hardware carrying the PUSH SDK (ADMS/iClock) firmware. Sold in GCC by Techzone (Dubai/Oman),
Datazone, Terrabyt, Technowave (Oman, Kuwait), Arabian United Technologies (Oman). Regional models: X990, K90 Pro, MB160, F22 (ZEM
family) and AI-Face Jupiter/Magnum/Orcus (ZAM family, reportedly ADMS-only with 4370 disabled). **No eSSL-operated cloud API exists.**

| Path | Type | Auth | Attendance | Employee push | Biometric sync | Events / webhooks | Cloud / partner requirements | Verification |
|---|---|---|---|---|---|---|---|---|
| ADMS / iClock push (`/iclock/*`, some firmware `.aspx`) | `DEVICE_PUSH_PROTOCOL` | None (SN only; cleartext; `Encrypt=None` default); HTTPS varies by firmware | ATTLOG rows, `ATTLOGStamp` cursor, `DATA QUERY ATTLOG StartTime= EndTime=` replay; dedupe on (SN, PIN, DateTime, Status/VerifyType) | Reported: `DATA UPDATE USERINFO`, `DATA DELETE USERINFO` | Reported: FP/FACE/BIODATA via OPERLOG and `DATA UPDATE FINGERTMP`/`BIODATA`; ZK-proprietary formats | Native push + heartbeat | Outbound HTTP(S) only; no licence; official spec distributed to partners | `REPORTED_SECONDARY` |
| eBioServer New Web API (`webservice.asmx`) + Web Hook | `ON_PREM_SERVER_API` | `UserName`/`UserPassword` per SOAP call; webhook uses a 32-char encryption password | `GetTransactionsLog`, `GetEmployeePunchLogs`, `DeviceCommand_GetDeviceLogs` (date range, no paging/ids) | `AddEmployee`, `AddMultipleEmployees`, `DeleteEmployee`, `UpdateEmployeewithExpiryDates`, `DeviceCommand_BlockUnBlockUser`, `GetCommandStatus` | UNKNOWN | Outbound Web Hook posting punches (optionally encrypted); `GetDeviceLastPing` | Customer/dealer-hosted Windows server; licensing UNKNOWN | `REPORTED_SECONDARY` |
| eTimeTrackLite Web `WebAPIService.asmx` (port 3366) | `ON_PREM_SERVER_API` | `UserName`/`UserPassword`; some methods use `AppKey`; failed auth returns HTTP 200 text | `GetTransactionsLog(FromDateTime, ToDateTime, SerialNumber, …)` tab-delimited; `GetAttendanceBetweenDates(AppKey, …)` | `AddEmployee`, `AddMultipleEmployees(ToDB)`, `BlockUnblockUser` (returns `CommandId`) | UNKNOWN | None | Customer-hosted IIS; edition dependency UNKNOWN; parameter dialects differ by build | `REPORTED_SECONDARY` |
| ePush Server (Java, port 8080) | `ON_PREM_SERVER_API` | Web UI login | MySQL tables only | UI only | UI only | None | Legacy — not recommended | `REPORTED_SECONDARY` |
| LAN SDK / port 4370 (zkemkeeper, pyzk) | `LAN_SDK` | Optional CommKey | Pull all/new logs | Yes | Fingerprint yes | While connected only | LAN agent; ZAM face units disable 4370 | `REPORTED_SECONDARY` |
| "eSSL Cloud API" | `VENDOR_CLOUD_API` | n/a — essl.co.in is a third party (CAMS) | — | — | — | — | Do not list until eSSL publishes one | `UNKNOWN` |

Doc URLs (from research): https://raw.githubusercontent.com/Vibhav-Aggarwal/zkteco-adms-server/main/docs/wire-format.md , https://github.com/Vibhav-Aggarwal/zkteco-adms-server ,
https://raw.githubusercontent.com/Vibhav-Aggarwal/terminal-firmware-atlas/main/README.md , https://raw.githubusercontent.com/StatCosol/app/main/backend/src/biometric/essl-iclock.controller.ts ;
eBioServer — https://github.com/gympact-in/Gympact , https://github.com/TheepanURK24CS1099/BIOMETRIC_PROJECT ; eTimeTrackLite — https://raw.githubusercontent.com/ametecsindia/SmartEPT_Admin/main/app/Services/Biometric/EsslProvider.php ,
https://github.com/rtdany10/etimetracklite . Blocked official manuals: `eBioServerNew-Web_API-Manual.pdf`, `eBioserver Web Hook Manual.pdf` (URLs in the research file).

**Recommended first integration: the shared ADMS/iClock receiver (`essl_push`, same handler as `zkteco_push`).** Cloud-first,
one receiver covers the two most common GCC brands, near-real-time, employee push via queued commands, no licence. Constraints:
pre-registered serial + per-device URL token (protocol has no auth), HTTPS where firmware allows with documented HTTP-only fallback
risk, idempotency on (SN, PIN, DateTime, Status, VerifyType), per-device `ATTLOGStamp` cursor, `DATA QUERY ATTLOG` replay for
reconciliation. eBioServer New as a second "middleware" provider only after obtaining the official manuals.

**Needs hardware / credentials to verify**

- Handshake option keys and command syntax on current eSSL firmware (ZEM vs ZAM), `.aspx` variants, `pushver` values.
- HTTPS (TLS 1.2+) support on AI Face / X990 / MB160 / K90 Pro / F22; custom CA / self-signed handling.
- `DATA UPDATE USERINFO` field set and whether user push works without a template; template push compatibility across families.
- ATTLOG VerifyType/Status mapping on eSSL firmware; `Stamp`/`OPERLOGStamp` replay; behaviour under prolonged downtime (buffer, resend order); polling cadence.
- eBioServer New WSDL, Web Hook schema and encryption algorithm, licensing, whether dealers host it publicly for GCC.
- eTimeTrackLite edition/version exposing `WebAPIService.asmx`, parameter dialect, `AppKey` provisioning.
- Official per-model ADMS support list; GCC-specific firmware (Arabic UI, WPS) effects; partner/NDA terms for the PUSH protocol document.

### 2.6 FingerTec

Malaysian brand (cloud arm TimeTec). Oman presence via Syscom/SYS LLC, SSD Oman (TA100C, TA700W), Concept Technologies (TA200 Plus);
UAE distributor Magnum Connect. Hardware is ZKTeco-derived. Current push-only generation (Face ID 5/6, Kadex+) uses AWDMS middleware.

| Path | Type | Auth | Attendance | Employee push | Biometric sync | Events / webhooks | Cloud / partner requirements | Verification |
|---|---|---|---|---|---|---|---|---|
| TimeTec TA Cloud API (SOAP, `api.timeteccloud.com/webservice/WebServiceTimeTecAPI.asmx`) | `VENDOR_CLOUD_API` | SOAP header `WebServiceSoapHeader` with `WSUsername`, `WSPassword`, `SecurityToken`; token from `WebServiceLogin(Username, Password)`; enabled via "TimeTec TA SDK Login" in TimeTec admin (reported) | `GetAttendance` / `GetAuditData(CompanyID, UserID, CheckTimeFrom, CheckTimeTo, RecordStartFrom, LimitRecordShow)`; `CheckType` 0=in/1=out; no record id confirmed; times `DD/MM/YYYY HH:MM` company-local | UNKNOWN | UNKNOWN / almost certainly not exposed | None found — poll only | Customer TimeTec TA subscription (a competing SaaS); Developer Program login; official manual `API-TimeTecCloud.pdf` not opened | `REPORTED_SECONDARY` |
| Device push to a Webster-compatible server ("Webserver/ADMS") | `DEVICE_PUSH_PROTOCOL` | UNKNOWN (ZKTeco ADMS style SN-only presumed) | Device pushes logs; payload for FingerTec firmware unverified | UNKNOWN for FingerTec firmware | UNKNOWN | Inherent | Outbound HTTP port 80/90 (reported); TLS unknown on FEM/FMM coreboards; no spec published | `UNKNOWN` |
| Webster (IIS + MySQL) DB read | `ON_PREM_SERVER_API` | MySQL credentials | SQL with incremental cursor (tables unverified) | UNKNOWN | UNKNOWN | None | Legacy, on-prem | `REPORTED_SECONDARY` |
| Ingress / TCMS V3 (+AWDMS) DB or export | `ON_PREM_SERVER_API` | MySQL/ODBC; export files | SQL or CSV/XLS import | UNKNOWN | Not via third party | None | On-prem only; migration/import use case | `REPORTED_SECONDARY` |
| BioBridge SDK (Windows DLL/ActiveX) | `LAN_SDK` | Device COMM key | Pull logs; realtime while connected | Reported yes | Reported fingerprint yes | SDK host only | **NDA required** ("not for sale"); Windows LAN agent | `REPORTED_SECONDARY` |

Doc URLs (from research): https://github.com/YousefShata/People-360-Integration , https://github.com/Izone425/CRM-v2/blob/f88b0ad1df0080f20a32151034a9d67cc6262acc/app/Services/LeaveAPIService.php ,
https://github.com/FSecureLABS/fingertec-tool . Blocked official: https://api.timeteccloud.com/webservice/WebServiceTimeTecAPI.asmx?WSDL ,
https://www.fingertec.com/developerprogram/usermanual/API-TimeTecCloud.pdf , https://www.fingertec.com/customer/download/postsales/SUM-Webserver-E.pdf ,
https://www.fingertec.com/developerprogram/biobridge/pdf/SDK-BioBridge.pdf . **Warning from the research:** the two GitHub repos contain live-looking credentials — never reuse or copy them.

**Recommended first integration: TimeTec TA SOAP API as a poll-based provider** (`WebServiceLogin` → `GetAuditData` windows
with `RecordStartFrom`/`LimitRecordShow` paging). Only FingerTec path with concrete endpoint evidence, pure cloud-to-cloud,
testable against a trial account without hardware, and GCC FingerTec customers are often already on TimeTec TA. Capabilities:
attendance pull only, no webhooks, no employee/biometric push, idempotency from (company, user, check time, check type),
company-local timestamps. In parallel, point a real FingerTec terminal at the shared ZKTeco ADMS endpoint (`fingertec_push`) and
promote it only after payload capture.

**Needs hardware / credentials to verify**

- Live WSDL diff: full operation list (user create/update? device list? terminal id per clocking?), types, SOAP 1.1/1.2.
- Trial TimeTec TA admin account: `WSUsername`/`WSPassword`/`SecurityToken` semantics, token lifetime, paging caps, rate limits (official PDF).
- Whether `GetAuditData` returns a stable record id and terminal id; `CheckTime` timezone; edited/deleted record behaviour.
- Real TA100C / TA500 / Face ID 4 or 5: capture Webserver/ADMS traffic against a FlowZa test server (`/iclock/cdata`, SN auth, heartbeat, backlog re-push, TLS, custom ports, server→device commands).
- Which models push directly vs need AWDMS; "push service v2.0" semantics with the distributor.
- Commercial: whether TimeTec allows a competing SaaS to consume its API at scale; GCC SKUs and TimeTec bundling.

### 2.7 Matrix Comsec (COSEC)

Mid-tier GCC brand: Al Maha Business Solutions (Muscat, sole supplier claim), Ainaan Networks (Muscat), ACIX Middle East (GCC VAD),
Techzone/Vinstreak (UAE), IPTech/TNG (Saudi). Regional product lines: ARGO / ARGO FACE, VEGA, DOOR series, PATH readers with
PANEL200P, plus CENTRA (on-prem) and VYOM (cloud SaaS — a direct FlowZa competitor).

| Path | Type | Auth | Attendance | Employee push | Biometric sync | Events / webhooks | Cloud / partner requirements | Verification |
|---|---|---|---|---|---|---|---|---|
| COSEC Devices PUSH API (device → server) | `DEVICE_PUSH_PROTOCOL` | Device provisioned with server URL/port + User ID + Password + HTTPS toggle; header scheme UNKNOWN (open-source server does not verify it) | Device calls `/login` (`device-type`, `serial-no`), `/poll`, `/getcmd`+`/updatecmd`, `/getconfig`+`/updateconfig`, `/setevent` (fields: user-id, credential mask, entry/exit …); plain-text `key=value` or XML; idempotency (serial-no, roll-over-count, seq-no); cmd 16 = current event sequence number | Yes (reported): config-id 10 "User configuration" (`ref-user-id`, `user-id` 1–15 alnum, name, PIN, card1/card2, active, validity); delete = cmd 7; **no "list all users"**, only a count | Cmd 1 enrol credential, 3/4 get/set credential (finger/card/palm), 8/9 user photo; face via PUSH API UNKNOWN; Matrix-proprietary templates | Native: `/setevent` + server-controlled `poll-interval` as heartbeat | Outbound HTTP(S) only; PUSH API guide publicly linked on matrixcomsec.com; device-side licence UNKNOWN; supported only on Direct Door Controllers (device-type 0 DOOR V3, 1 PVR DOOR, 2 VEGA, 3 DOOR FMX, 5 ARC DC200, 7 ARGO) — not PANEL200P topologies | `REPORTED_SECONDARY` |
| COSEC Device API (DAPI, LAN `device.cgi`) | `LAN_DEVICE_API` | HTTP Basic (some firmware Digest) with device admin | `GET /device.cgi/events?action=getevent&roll-over-count=&seq-number=&no-of-events=` → cursor (roll-over-count, seq-No); `detail-2` odd=IN/even=OUT (Horilla mapping) | `/device.cgi/users?action=set&user-id=…&ref-user-id=…&name=…&card1=…&user-pin=…`; `action=delete` | `credential?action=get|delete&type=1..6` (5/6 face, ARGO FACE only); upload syntax unverified | None — polling | LAN reachability (agent/VPN) | `REPORTED_SECONDARY` |
| COSEC CENTRA Platform API | `ON_PREM_SERVER_API` | UNKNOWN (likely CENTRA API user) | UNKNOWN in detail | Reported possible | UNKNOWN | UNKNOWN | Customer owns CENTRA (dongle-licensed); API enablement per partner mailers MTSM-11/18 | `REPORTED_SECONDARY` |
| COSEC VYOM cloud API | `VENDOR_CLOUD_API` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | Customer VYOM subscription; AWS region UNKNOWN; competes with FlowZa | `UNKNOWN` |
| DB-to-DB / export templates (CENTRA) | `OTHER` | DB credentials / file share | Read CENTRA tables or ingest CSV | Not recommended | No | None | CENTRA install | `REPORTED_SECONDARY` |

Doc URLs (from research): official PUSH API guide (not openable in research) — https://matrixcomsec.com/wp-content/uploads/2023/08/COSEC_DEVICES_PUSH_API_GUIDE.pdf ;
opened community sources — https://raw.githubusercontent.com/saidmtanzania/biometric/main/docs/DEVICE_PLATFORM_ARCHITECTURE.md , https://raw.githubusercontent.com/saidmtanzania/biometric/main/src/services/cosecService.js ,
https://pypi.org/pypi/pycosec/json , https://raw.githubusercontent.com/KSreethul/pycosec/main/README.md , https://raw.githubusercontent.com/horilla/horilla-hr/1.0/biometric/views.py .
Blocked: https://www.matrixcomsec.com/cosec-time-attendance-integration-with-third-party-software/ , https://www.matrixcomsec.com/product/cosec-vyom/ , TNG MTSM-11/18 PDFs.

**Recommended first integration: COSEC Devices PUSH API (device → FlowZa).** Only Matrix path matching the cloud-first,
no-LAN-agent posture; officially supported on all current direct door controllers; covers events, user push, user delete,
credential enrol/get/set, door commands, time sync and reboot; shares its vocabulary with the LAN Device API. Build it as a
per-tenant push endpoint (e.g. `/device-push/matrix/{tenant-token}/{login|poll|getcmd|updatecmd|getconfig|updateconfig|setevent}`)
answering plain-text `key=value`, idempotent on (serial-no, roll-over-count, seq-no), and mark it VERIFIED only after the official
PDF is read and a lab device confirms behaviour. Ship the LAN Device API second; defer CENTRA/VYOM connectors.

**Needs hardware / credentials to verify**

- Read the official PUSH API guide: endpoint/parameter names, text vs XML, auth header scheme, response codes.
- Minimum firmware per model (ARGO, ARGO FACE, VEGA, DOOR FMX/V3/PVR, ARC DC200); whether ARGO FACE is device-type 7.
- Auth mechanism toward the third-party server; self-signed vs public CA; SNI/TLS versions.
- Store-and-forward: buffering/resend on non-200, buffer size, roll-over-count/seq-no across reboots and factory default.
- Exclusivity vs CENTRA/VYOM; on-device Asia/Muscat time handling.
- Face template/image push (cmd 4/9) format, size limits, portability between ARGO FACE units.
- `user-id` (1–15 alnum) / `ref-user-id` (8 digits) vs FlowZa employee numbers; Arabic names on device.
- Device-side licence/feature key requirements; how Al Maha / Ainaan provision third-party server settings.
- DAPI Basic vs Digest per firmware; credential upload syntax; CENTRA/VYOM API existence, auth, licensing, data residency.

### 2.8 NITGEN

Korean brand (Union Community group, sister brand VIRDI). Second-tier GCC footprint concentrated in Saudi/UAE (Prestige Saudi,
Softworld, eTOP, DLI-IT); **no Oman-based distributor found**. Regional models: eNBioAccess-T1/T2/T3/T5/T9, NAC-5000, Fingkey Hamster
USB scanners. **No NITGEN cloud API, developer portal or documented device-to-cloud push protocol was found.**

| Path | Type | Auth | Attendance | Employee push | Biometric sync | Events / webhooks | Cloud / partner requirements | Verification |
|---|---|---|---|---|---|---|---|---|
| AccessManager Professional SDK (Windows) | `ON_PREM_SERVER_API` | UNKNOWN (runs on the AccessServer host; ports 7331/7332) | "Real-time events and historical logs" via SDK (reported); call names/paging UNKNOWN | Reported (enrolment, synchronise devices) | Reported (fingerprint templates, NBioBSP FIR); face UNKNOWN | SDK callbacks (unverified) | Windows DLL/COM SDK — needs a LAN Windows bridge agent; licence/NDA terms UNKNOWN | `REPORTED_SECONDARY` |
| AccessManager DB read (`NGAC_LOG`) via bridge agent | `ON_PREM_SERVER_API` | DB credentials (MDB password / SQL Server login) | Poll `NGAC_LOG` (`nodeid, userid, logtime, authresult, authtype, functionno, logindex, slogtime`) by `slogtime`/`logindex`; `authresult=0` = success | Not via DB | Not available | Bridge emits its own webhook | Customer's AccessManager install; not a NITGEN-supported interface | `REPORTED_SECONDARY` (community code read) |
| Terminal TCP protocol (7331/7332) | `DEVICE_PUSH_PROTOCOL` | UNKNOWN (proprietary) | Device pushes logs to configured server IP | Server distributes users (via AccessManager) | Server distributes templates | Device-initiated TCP | Undocumented; would need NDA/reverse engineering — not a build target | `REPORTED_SECONDARY` |
| eNBSP / NBioBSP SDK (USB scanners) | `LAN_SDK` | None | n/a | n/a | Local capture/templates only | n/a | Enrolment scanners only, not terminals | `REPORTED_SECONDARY` |
| Vendor cloud API | `VENDOR_CLOUD_API` | n/a — none found | — | — | — | — | Confirm with NITGEN/Union Community | `UNKNOWN` |

Doc URLs (from research): https://github.com/sejator/nitgen-service , https://github.com/sejator/nitgen-service/blob/master/src/fingerprint_handler.py (cloned and read);
SDK listings (blocked) — https://accessmanager-professional-sdk.software.informer.com/ , https://www.kimaldi.com/en/products/biometric_systems/nitgen-en/access_control_software_access_manager_pro/ ;
manuals (blocked) — https://www.manualslib.com/manual/1334678/Nitgen-Enbioaccess-T2.html?page=23 , https://www.manualslib.com/manual/955868/Nitgen-Nac-5000.html , http://www.nitgen.com/admin/cs_center/fileupload/EN_NAC5000.pdf .

**Recommended first integration: a "NITGEN AccessManager Bridge"** — a small Windows agent on the customer's AccessManager
server that polls `NGAC_LOG` by cursor and forwards punches over HTTPS with idempotency key (org, `nodeid`, `logindex`), structured so
the Professional SDK can be added later for employee/template push. Capabilities: attendance pull only; employee/biometric push
UNSUPPORTED until the SDK is licensed and verified. Keep NITGEN effort minimal given weak Oman presence.

**Needs hardware / credentials to verify**

- Official AccessManager Professional SDK manual: function list, callbacks, paging, unique log ids, user/template push, terminal list, licence/dongle/NDA.
- Actual `NGAC_LOG` schema on current Standard (MDB) and Professional (MS SQL) installs; meaning of `authtype`/`authresult`/`functionno`; `logindex` uniqueness; `userid` formatting; timezone of `logtime` vs `slogtime`.
- Whether current versions still use `NITGENDBAC.mdb` / `NITGENDBAC_EXT.mdb`; default DB passwords.
- Terminal firmware: hostname vs IP, TLS, NAT/Internet behaviour, wire protocol (packet capture or spec).
- Face template push for T9 / NAC-5000 FACE; any Union Community cloud covering NITGEN terminals; models stocked by GCC resellers serving Oman.

---

## 3. Compatibility matrix

Columns reflect the **declared** capability matrix in `packages/device-providers/src/providers/**` (mirrored in
`device_providers` by the registry test). "Declared" is not "verified": the last two columns tell you how much to trust it.
Research level is the best level found for that provider's primary path.

| Vendor | Provider key | Mode (`integration_type`) | Attendance pull / push | Employee push | Employee pull | Fingerprint | Face | Card | Webhooks | Research verification | Status in FlowZa |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FlowZa | `mock` | `VENDOR_CLOUD_PULL` (also simulates webhook + device push) | pull yes / push via simulator protocol | yes | yes | yes | yes | yes | yes (simulated, signed) | n/a (`VERIFIED` simulator) | **implemented** (`available`) |
| ZKTeco | `zkteco_push` | `DEVICE_PUSH` (protocol `iclock`) | pull no / push yes | yes (queued `DATA UPDATE USERINFO`) | yes, asynchronous (`DATA QUERY USERINFO` → OPERLOG) | declared yes | declared yes | declared yes | no | `REPORTED_SECONDARY` | **beta** — protocol handler + provider implemented from public descriptions; **no HTTP route yet**; no hardware run |
| ZKTeco | `zkteco_biotime` | `ON_PREM_SERVER_API` | pull yes / push no | yes | yes | no | no | yes | no | `VERIFIED_OFFICIAL_DOC` (8.0 manual) | placeholder |
| Hikvision | `hikvision_isapi` | `LAN` | pull yes / push no | yes | yes | yes (+ template push declared) | yes | yes | yes (`httpHosts`, unsigned) | `REPORTED_SECONDARY` | placeholder |
| Hikvision | `hikvision_hpp` | `VENDOR_CLOUD_PULL` | pull yes / push no | no | no | no | no | no | declared yes — payload UNKNOWN | `REPORTED_SECONDARY` | placeholder (partner credentials required) |
| Suprema | `suprema_biostar2` | `ON_PREM_SERVER_API` | pull yes / push no | yes | yes | yes (+ template push declared) | yes | yes | no | `VERIFIED_OFFICIAL_DOC` (Postman collection) | placeholder |
| Anviz | `anviz_crosschex_cloud` | `VENDOR_CLOUD_PULL` | pull yes / push no | declared yes — research says UNKNOWN | declared yes — UNKNOWN | no | no | yes | declared no — research says webhooks exist (reported) | `REPORTED_SECONDARY` | placeholder |
| eSSL | `essl_push` | `DEVICE_PUSH` (shares `iclock` handler) | pull no / push yes | yes | yes | yes | yes | yes | no | `REPORTED_SECONDARY` | placeholder (handler shared, every operation throws until hardware-verified) |
| FingerTec | `fingertec_push` | `DEVICE_PUSH` (shares `iclock` handler) | pull no / push yes | yes | yes | yes | yes | yes | no | `UNKNOWN` (push path) / `REPORTED_SECONDARY` (TimeTec API, not modelled) | placeholder |
| Matrix Comsec | `matrix_cosec` | `ON_PREM_SERVER_API` (CENTRA/VYOM) | pull yes / push no | yes | yes | no | no | no | no | `REPORTED_SECONDARY` (PUSH API — a different path than the one modelled) | placeholder |
| NITGEN | `nitgen` | `ON_PREM_SERVER_API` | pull yes / push no | yes | yes | no | no | no | no | `REPORTED_SECONDARY` (no API found; bridge recommended) | placeholder |

Feature flags gating the wizard (reference data): `provider_zkteco_push` (on, 100 %), `provider_hikvision`,
`provider_suprema`, `provider_anviz` (all off), `biometric_template_sync` (off, legal review required).

Known **drift between declared capabilities and the research** that must be resolved before any of these leave
`placeholder` (see also §8):

1. `anviz_crosschex_cloud` declares `employeePush/employeePull/employeeDelete = true` and `webhooks = false`; the research
   has employee endpoints as UNKNOWN and webhooks as reported-existing. The recommended honest definition is the inverse.
2. `hikvision_hpp` declares `webhooks = true`; the callback payload and registration are UNKNOWN.
3. `matrix_cosec` models the CENTRA/VYOM server API (auth UNKNOWN); the research recommends the device PUSH API instead,
   which would be a `DEVICE_PUSH` provider with its own protocol handler.
4. `nitgen` models a "Server URL + API key" that does not exist in the research; the realistic path is a bridge agent.
5. `fingertec_push` is modelled only as a ZKTeco-derived push device; the research's recommended first path (TimeTec TA SOAP
   API, `VENDOR_CLOUD_PULL`) is not modelled at all.
6. `zkteco_push` maps ATTLOG `Verify` codes `{0 password, 1 fingerprint, 2 card, 15 face}`; the research additionally reports
   `4 = card` and `25 = palm` (`ZK_VERIFY_METHODS` in `push-protocol.ts` should be extended once confirmed on hardware).

---

## 4. What is implemented in this repository today — honest status

### Implemented and tested without hardware

- **Provider contract and registry** (`types.ts`, `definition.ts`, `registry.ts`): `DeviceProvider`, `ProviderDefinition`
  (validated by `defineProvider`, secrets derived from `configSchema`), `ProviderError` with a provider-agnostic retry table,
  `ProtocolError`, `createProviderRegistry` (duplicate-key and conflicting-protocol detection), `definitionToRow` for keeping
  `device_providers` in sync. The registry test asserts every provider definition matches its migration row.
- **Throttler** (`throttle.ts`): per-device / per-account concurrency and requests-per-minute tokens; `ctx.acquire()` hook.
- **Conformance suite** (`conformance.ts`, `describeProviderConformance`): definition consistency, capability gates (an operation
  whose capability is `false` must reject with `ProviderError`), pagination and idempotency checks.
- **Mock provider** (`providers/mock/*`, `status='available'`, `VERIFIED`): deterministic seeded transaction stream, nine
  scenarios (`healthy`, `flaky`, `offline`, `slow`, `duplicates`, `unknown_employees`, `large_batches`, `auth_failed`,
  `rate_limited`), simulated webhook with two signature transports, and a tiny `mock` push protocol
  (`/device-push/mock/:serial/{attendance|commands|handshake|command-results}`) so the `DEVICE_PUSH` path can be exercised end
  to end in tests. **It is a simulator; it proves the pipeline, not any vendor.**
- **ZKTeco PUSH/ADMS protocol handler** (`providers/zkteco/push-protocol.ts`, protocol key `iclock`): handshake option block
  (`ATTLOGStamp`/`OPERLOGStamp` from `ctx.stamps`, `TransFlag` excluding templates), `ATTLOG` line parser → `RawTransaction`
  (`providerTransactionId = null`, dedupe hash applies), `OPERLOG USER` parser → `DeviceEmployee` (templates/photos counted and
  dropped), `getrequest` heartbeat with `INFO=` parsing, `devicecmd` result parsing, command rendering
  (`DATA UPDATE USERINFO`, `DATA DELETE USERINFO`, `DATA QUERY USERINFO`, `REBOOT`), strict input validation (PIN, card,
  password, name sanitising, serial pattern), and acknowledgement of `ATTPHOTO`/`BIODATA`/`registry`/`push`/`ping`/`querydata` without
  storing anything. Every mapping is annotated `REPORTED` in the source.
- **ZKTeco push provider** (`providers/zkteco/provider.ts`, `zkteco_push`, `status='beta'`, `REPORTED`): `testConnection`/
  `getDeviceStatus` derive liveness from `config.lastSeenAt` (maintained by the — not yet existing — push route);
  `pullAttendance` throws `UNSUPPORTED` (nothing to pull); `listEmployees` throws `UNSUPPORTED` with the `QUERY_USERS` command in
  `details` rather than returning an empty page that would look like "no users"; `upsertEmployee`/`deleteEmployee`/`restart`
  return `async: true` with the protocol commands to persist.
- **Placeholders** (`providers/placeholders.ts`): nine definitions with config schemas and declared capabilities so the wizard can
  render them; **every operation throws `ProviderError('NOT_IMPLEMENTED')`** pointing at this document. `essl_push` and
  `fingertec_push` extend `ZKTecoPushProvider` in `mode: 'placeholder'` — they share the `iclock` handler (registry dedupes it) but
  their provider operations still throw until hardware is verified.

### Not implemented (do not describe these as working)

- **No inbound HTTP routes.** `apps/api/src/routes/inbound/index.ts` is a stub (`void app; void deps;`). Neither
  `/device-push/:protocolKey/*` nor `/webhooks/providers/:providerKey` exists yet, so **no real device can talk to FlowZa
  today**, including ZKTeco. The handler is a library waiting for its host.
- **No `device_commands` persistence flow, no stamp persistence, no `lastSeenAt` maintenance** — all of these are
  responsibilities the push route/worker must implement around the handler (the handler is deliberately stateless).
- **No worker sync handlers wired to providers** yet (`apps/worker/src/handlers/index.ts` is a skeleton).
- **No vendor adapter other than the ZKTeco push handler has a single line of protocol code.** BioTime, ISAPI, HPP,
  BioStar 2, CrossChex, COSEC, NITGEN are definitions only.
- **No biometric template handling anywhere** (by design; flag off).
- **No hardware has ever been connected.** The ZKTeco handler's field mappings, status/verify codes, handshake format and
  command grammar come from open-source servers and search excerpts of the official (blocked) PUSH SDK PDFs — see the header
  comment in `push-protocol.ts`. It stays `beta` until §7 is completed on real terminals.
- **Reference data drift:** the `mock` row in the migration lists seven scenarios and three config fields while the code
  definition has nine scenarios and eight fields; the registry test only asserts that migration fields exist in the code
  definition (subset), so this passes but the wizard will show fewer options than the provider accepts until the row is
  regenerated with `definitionToRow`. Blueprint §E.3 also uses stale keys (`essl`, `fingertec_ingress`) and lists
  `zkteco_biotime` as `VENDOR_CLOUD_PULL`, whereas the code registers `essl_push`, `fingertec_push` and `ON_PREM_SERVER_API`.

---

## 5. Adding a vendor — step by step for engineers

Follows blueprint §L. Nothing in `packages/domain`, the sync engine, API routes or UI should change.

1. **Due diligence first.** Add or update the vendor section in this document: integration paths, auth, cursor/idempotency
   source, employee push, biometric stance, webhooks, rate limits, cloud/partner requirements, doc URLs and a verification level
   per claim. Decide the mode (`INTEGRATION_TYPES`). If the vendor offers no transaction id, state the dedupe key.
2. **Create `packages/device-providers/src/providers/<vendor>/`** with:
   - `definition.ts` — `defineProvider({...})` with `key` matching `^[a-z][a-z0-9_]{1,63}$`, `integrationType`, `status`
     (`placeholder` until verified), **only capabilities you can prove** (unknown ⇒ `false`), `configSchema.fields[]`
     (mark secrets `secret: true` or type `password` — `secretFieldsOf` derives what goes to `device_credentials`),
     `throttling`, `verificationStatus`, `docsUrl`.
   - `provider.ts` — implement `DeviceProvider`. Map vendor records to `RawTransaction` (`providerTransactionId`,
     `deviceEmployeeId`, `punchedAt` UTC via `parseDeviceTime`/`toIsoUtc`, `deviceLocalTime`, `verificationMethod`,
     `direction`, `rawPayload` without secrets) and `DeviceEmployee` (never templates; `extra` is opaque vendor data). Map vendor
     failures to `ProviderError` codes (`AUTH_FAILED`, `DEVICE_OFFLINE`, `RATE_LIMITED` with `retryAfterMs`, `TIMEOUT`,
     `VENDOR_ERROR`, …). Call `await ctx.acquire()` before every outbound request. Honour `ctx.signal`.
   - For `DEVICE_PUSH`: a `DevicePushProtocolHandler` (`protocolKey` = path segment, `identifyDevice`, `parseInbound`,
     `renderCommands`, `buildCommands`). Keep it stateless; return protocol facts in `meta`; throw `ProtocolError` with the HTTP
     status the device expects. Never block: parse and return.
   - For `VENDOR_WEBHOOK`: `handleWebhook(req, secrets)` returning `eventId`, `signatureValid`, `vendorDeviceId`, transactions and
     the vendor's expected response.
   - Operations the vendor cannot do must throw `unsupported(...)`; operations you have not verified must throw
     `notImplemented(...)`. Returning an empty page or `ok: true` for something that did not happen is a §135 violation.
3. **Register** in `defaultProviders()` (`registry.ts`) and add the key to `PROVIDER_SORT_ORDER`.
4. **Reference data.** Add the `device_providers` row (and `device_models` rows with *verified* capabilities only) to the
   reference-data migration using `definitionToRow(def)` as the source of truth; the registry test fails on any mismatch.
   Add a `provider_<vendor>` feature flag defaulting to off.
5. **Tests.** Unit-test the parser/mapper against recorded fixtures (sanitised captures from a real device or vendor sandbox).
   Run `describeProviderConformance('<key>', factory)` with `createTestProviderContext()`. Add the protocol handler's request/
   response fixtures. `pnpm --filter @flowza/device-providers run test`, then `pnpm build:packages && pnpm typecheck`.
6. **Hosting.** For pull providers, the worker sync handler already dispatches by `integration_type` (once implemented); for push
   protocols the API route mounts `/device-push/<protocolKey>/*` from `registry.pushProtocols()` — no per-vendor route code.
7. **Promotion.** `placeholder → beta` when end-to-end tests pass against a simulator/fixtures; `beta → available` and
   `verificationStatus → VERIFIED` only after the hardware checklist (§7 pattern) is executed on a real device/server and the
   results (model, firmware, date, tester, deviations) are appended to this document. Update the compatibility matrix and the
   customer-facing device list in the same PR.
8. **Report** any new dependency in your final report (rule 10) — prefer what is installed.

---

## 6. Hardware verification checklist — Oman pilot (ZKTeco push devices first)

Scope: promote `zkteco_push` from `beta` to `available`/`VERIFIED`, then decide whether `essl_push` and `fingertec_push` can
leave `placeholder`. Prerequisites: the `/device-push/iclock/*` route, `device_commands` persistence, stamp persistence and
`lastSeenAt` maintenance must exist first (§4). Record results per device in a table appended to §7.

### 6.1 Procurement and documents

- [ ] Obtain at least one **push v2** terminal (e.g. K40 / F22 / MB360) and one **push v3 / visible-light** terminal
      (SpeedFace / SenseFace) from an Oman distributor (Startech ME, AIMS, Ainaan Networks, Zayn Technology); record model,
      firmware, `pushver`, `DeviceType` (watch for `middle east`).
- [ ] Request the official "Attendance PUSH Communication Protocol" / PUSH SDK PDF from ZKTeco ME (Dubai) or the distributor;
      record NDA/pricing terms. Open https://www.zkteco.com/en/PUSHSDK and https://www.zkteco.com/en/ADMS.
- [ ] Ask the distributor for the ADMS compatibility list and which legacy units need the `ZK-TW-FW-UP` firmware upgrade.
- [ ] Borrow one eSSL (X990 / MB160 / AI Face) and one FingerTec (TA100C / Face ID) unit for the shared-handler tests in 6.6.

### 6.2 Connectivity

- [ ] Configure COMM > Cloud Server Setting with FlowZa's hostname (Enable Domain Name), port, HTTPS on. Confirm the device
      reaches a **public-CA HTTPS** endpoint; note TLS version/ciphers, SNI and redirect behaviour.
- [ ] Repeat over plain HTTP to characterise the legacy fallback; document the risk if a firmware is HTTP-only.
- [ ] Test through the device's proxy setting and over 4G/Wi-Fi if the pilot site uses them.
- [ ] Verify the device tolerates FlowZa response latency (target: route answers in < 200 ms; measure `ErrorDelay` behaviour).

### 6.3 Handshake and heartbeat

- [ ] Capture `GET /iclock/cdata?SN=…&options=all&pushver=…` and confirm our option block is accepted (`ATTLOGStamp`,
      `OPERLOGStamp`, `ErrorDelay`, `Delay`, `TransTimes`, `TransInterval`, `TransFlag`, `Realtime`, `Encrypt=None`).
      Record any unknown keys the device sends (`PushOptionsFlag`, `language`, `DeviceType`).
- [ ] Confirm `getrequest` cadence follows `Delay`; confirm `INFO=` fields (firmware, user/fp/att counts) parse; confirm
      `lastSeenAt`-based online/offline detection in `getDeviceStatus`.
- [ ] Push v3 units: capture `/iclock/registry` and `/iclock/push` and decide whether `RegistryCode`/`SessionID` handling is
      required (currently acknowledged and ignored).

### 6.4 Attendance ingestion

- [ ] Punch with fingerprint, card, face, password (and palm if available); confirm `ATTLOG` `Verify` codes map correctly and
      extend `ZK_VERIFY_METHODS` (research reports `4 = card`, `25 = palm`). Confirm `Status` codes 0–5 and what `255` means.
- [ ] Confirm `workcode`/reserved columns and whether `PIN` is numeric only.
- [ ] Confirm timestamps are device-local without offset and that `parseDeviceTime(…, 'Asia/Muscat')` yields correct UTC.
- [ ] Take the server offline for > 1 h and > 24 h; verify buffered records arrive, `Stamp` semantics, and that replay produces
      **zero duplicates** in `attendance_raw_transactions` (dedupe hash). Test the `None` stamp full-resend path.
- [ ] Queue `DATA QUERY ATTLOG` (not yet a `buildCommands` op) and decide whether to add it for reconciliation.
- [ ] Load: simulate 500 devices' `getrequest` cadence against the route and record p95 latency and DB write rates.

### 6.5 Employee commands

- [ ] `UPSERT_EMPLOYEE`: Latin and **Arabic** names (rendering on device, 24-char sanitising), card numbers, 1–8 digit
      passwords, `Pri=0` vs `14`; confirm `devicecmd` `Return=0` and other codes; confirm the user appears on the device.
- [ ] `DELETE_EMPLOYEE`, `RESTART`, `QUERY_USERS` (OPERLOG `USER` lines parse into `DeviceEmployee`; template lines are dropped
      and counted).
- [ ] Confirm behaviour when a command references an unknown PIN and when the device is offline (command stays queued).
- [ ] Confirm OPERLOG enrolment events after on-device fingerprint/face enrolment and that **no template bytes are persisted**.

### 6.6 Shared-handler vendors (eSSL, FingerTec)

- [ ] Point the eSSL and FingerTec units at the same endpoint; capture handshake, ATTLOG, OPERLOG; note `.aspx` variants,
      `pushver`, port 80/90 behaviour, HTTPS support.
- [ ] Repeat 6.4 and 6.5 per unit. Only if everything passes: switch `EsslPushProvider`/`FingerTecPushProvider` to `mode: 'beta'`,
      set their rows to `beta`/`REPORTED`, and add `device_models` rows for the exact models tested.

### 6.7 Security and operations sign-off

- [ ] Unknown serial numbers are rejected (or quarantined) — the protocol has no auth; document the per-tenant serial allow-list
      and per-device path token.
- [ ] No credentials/`commKey` ever appear in logs or `rawPayload`; `ProtocolError` responses leak nothing.
- [ ] Rate limiting on the push route; alerting on devices silent for > 3 × `pushInterval`.
- [ ] Data-residency note for the pilot customer (Supabase region, no vendor cloud in the path).
- [ ] Update this document (§7 results table, §3 matrix), the reference-data row (`status`, `verification_status`,
      `device_models`) and the customer-facing supported-devices list in one PR.

---

## 7. Verification log

| Date | Provider | Vendor / model / firmware | Tester | Mode | Result | Deviations / notes |
|---|---|---|---|---|---|---|
| — | — | *No hardware or live vendor system has been tested yet.* | — | — | — | — |

---

## 8. Open items to reconcile (code ⇄ research ⇄ blueprint)

1. ~~Implement `/device-push/:protocolKey/*` and `/webhooks/providers/:providerKey` in `apps/api`~~ — **done**
   (`apps/api/src/routes/inbound`, `services/features/inbound.service.ts`: pending-device quarantine, per-device push token,
   `device_commands` rendering/acks, stamp persistence, heartbeat maintenance, webhook signature verified once over the raw
   bytes). Still open for this item: **zero-touch claim proof of possession** — an unattributed pending row can be claimed by
   any organisation that knows the serial (denial-only today because uploads without the per-device token are refused; see
   `docs/risks.md` D26). Planned: claim → device in a verification state → `pending_devices` link set on the first
   token-authenticated push; hide `remote_ip` from unattributed rows; TTL purge / per-IP cap for pending rows.
2. Re-derive the `mock` reference row from `definitionToRow(MOCK_DEFINITION)` (scenario list and fields drifted).
3. Fix blueprint §E.3 keys and modes (`essl_push`, `fingertec_push`; `zkteco_biotime` is `ON_PREM_SERVER_API`).
4. Correct `anviz_crosschex_cloud` and `hikvision_hpp` declared capabilities to match the research (see §3 drift list).
5. Decide whether `matrix_cosec` should become a `DEVICE_PUSH` provider (COSEC PUSH API) and whether `nitgen` should be
   re-modelled as a bridge-agent provider, or both be kept as honest `UNVERIFIED` placeholders with corrected descriptions.
6. Consider a `fingertec_timetec` (`VENDOR_CLOUD_PULL`) placeholder reflecting the research's recommended first path.
7. Extend `ZK_VERIFY_METHODS` with `4 → card`, `25 → palm` after hardware confirmation; add `DATA QUERY ATTLOG` to `buildCommands`.
8. Track official documents still to be opened (all blocked during research): ZKTeco PUSH SDK PDFs, Hikvision TPP wiki, Anviz
   community API definition, Suprema support KB (WebSocket, licence tiers), eSSL eBioServer manuals, Matrix PUSH API guide, NITGEN
   SDK manual, FingerTec API-TimeTecCloud.pdf and WSDL.
