# HR system (HRMS) integration — Mawred Plus and others

Keep **employees** and **organisational units** (departments) in FlowZa Time up to date from the organisation's HR system:
Mawred Plus (the Omani government HR system) or any other HRMS. The HR system — or the middleware that exports from it —
sends **batches** of records to FlowZa Time with an **organisation API key**. Each batch goes through the same pipeline as a
file uploaded on **Employees → Import**: the records are mapped, validated, stored as an import, and applied in the
background by the worker (`EXECUTE_IMPORT`).

| | |
|---|---|
| Where it is configured | **Settings → HR system** (permission `integration.manage`; owners and organisation admins have it) |
| Endpoints | `POST /api/v1/inbound/hrms/employees`, `POST /api/v1/inbound/hrms/org-units`, `GET /api/v1/inbound/hrms/batches/:id` |
| Authentication | `Authorization: Bearer fzk_…` — an organisation API key with the scope `hrms:write` (send) or `hrms:read` (status) |
| Processing | asynchronous: `202 { jobId, status: 'QUEUED', batchId, … }`, then poll the batch |
| Migration | `supabase/migrations/20261019000600_hrms_integration.sql` |

---

## 1. Connect the HR system

1. **Settings → HR system**: switch on **Receive batches from the HR system**, choose the **field mapping preset**
   (*Mawred Plus* or *Generic*), click **Fill in the preset's mapping**, adjust it (§3) and **Save**.
2. Optionally set a **Default branch code**: the branch of a *new* employee whose record names none (an HR system usually knows
   nothing about FlowZa Time's branches). Without it, such records are refused.
3. **API keys → Create API key**: a name, the access (*Send batches* `hrms:write`, *Read batch status* `hrms:read`) and a
   validity (1–730 days, default 365). The key (`fzk_<8 characters>_<43 characters>`) is shown **once**: store it in the HR
   system's secret store. FlowZa Time keeps only its sha256; the list shows the public prefix (`fzk_AbCdEfGh…`), the scopes,
   the status (active / expired / revoked), the last use and the expiry.
4. Point the HR system at the **Endpoint** shown on the card (`<API>/api/v1/inbound/hrms`).

**Rotating a key:** create a new key, switch the HR system to it, then **Revoke** the old one (immediate, cannot be undone).
Keys always expire; an organisation holds at most 20 keys that are not revoked.

## 2. Sending batches

```http
POST /api/v1/inbound/hrms/employees
Authorization: Bearer fzk_AbCdEfGh_…
Idempotency-Key: mawred-2026-10-19-0700
Content-Type: application/json

{
  "reference": "MAWRED-2026-10-19-0700",
  "records": [
    { "CivilID": "12345678", "EmployeeNo": "M-1001", "FullNameAr": "فاطمة البلوشية", "FirstNameEn": "Fatma", "LastNameEn": "Al Balushi",
      "HireDate": "2026-10-01", "OrgUnitCode": "ER", "JobTitleCode": "HR-OFF", "EmploymentStatus": "على رأس العمل" },
    { "EmployeeNo": "M-0870", "EmploymentStatus": "مستقيل", "ServiceEndDate": "2026-10-15" }
  ]
}
```

- **Records**: 1–500 per batch (more → several batches), each a flat JSON object of at most 80 fields with scalar values
  (text ≤ 500 characters, numbers, booleans, null). Body ≤ 5 MB.
- **Employees are upserted by employee number.** A record whose employee number exists **updates** that employee — only
  the fields the record carries (an absent or empty field leaves the stored value alone); any other record **creates** one
  and needs at least the employee number, first and last name, joining date and a branch (record or default branch).
- **Org units are upserted by code** (`POST …/org-units`): name, Arabic name, parent (by code), branch (by code), head (by
  employee number), status `active` / `inactive`. Parents may be in the same batch: they are linked once every unit exists.
  A parent that would make a loop — through the batch and the existing tree together — is refused on each unit of the loop.
  Archived departments are never changed by a batch.
- The **organisation is the key's**. A record cannot name another organisation: unknown fields (an `organizationId`
  included) are ignored and listed in the batch summary (`ignoredFields`).
- **Answer**: `202 { data: { jobId, status: 'QUEUED', batchId, kind, totalRows, validRows, errorRows } }`. Records with errors
  are refused individually; the others are applied. A batch **without one valid record** answers `422 UNPROCESSABLE` with the
  first errors in `details.errors` (the batch is kept, status `FAILED`, for the audit trail).
- **Idempotency-Key** (optional, ≤ 128 characters, stored per organisation): repeating it with the same body answers the
  batch it created (`idempotency-replayed: true`), never applying it twice; with a different body → `409 IDEMPOTENCY_CONFLICT`.
- **Batch status**: `GET /api/v1/inbound/hrms/batches/:batchId` → `{ batchId, kind, status, reference, totalRows, validRows,
  errorRows, importedRows, summary, errors[] }`. `status` goes `IMPORTING` → `COMPLETED` (or `FAILED` when the job itself
  failed). `errors` lists up to 200 `{ rowNo, status, field, message }` — `rowNo` is the record's position in the batch (from
  1); a record applied whose manager / parent could not be linked keeps `status: imported` with the reason. `summary` holds
  `created`, `updated`, `unchanged`, `failed`, `invalid`, `linkFailed` once the batch completed.

| Answer | When |
|---|---|
| `401 UNAUTHENTICATED` (+ `WWW-Authenticate: Bearer`) | no key, malformed, unknown, revoked or expired key |
| `403 FORBIDDEN` | the key lacks the scope; the organisation is suspended / closed |
| `403 FEATURE_DISABLED` | the feed is switched off in Settings → HR system |
| `400 VALIDATION_ERROR` | malformed body, 0 or more than 500 records, a record with nested values or more than 80 fields |
| `402 ENTITLEMENT_EXCEEDED` | the new active employees of the batch would pass the organisation's user limit (nothing stored) |
| `413 PAYLOAD_TOO_LARGE` | body over 5 MB |
| `422 UNPROCESSABLE` | no valid record (see above) |
| `429 RATE_LIMITED` (+ `Retry-After`) | more than 60 requests a minute for one key, or 300 a minute from one client address |

## 3. Field mapping (and the Mawred Plus preset)

The mapping translates the HR system's field names into FlowZa Time's. It is stored in
`organization_settings.integrations.hrms` as lists of `{ source, target }` pairs — one list for employee fields, one for
org-unit fields, and three **value translations** (employment status, gender, contract type: the HR system's Arabic or
English labels → FlowZa values). Matching is case-insensitive. **An empty list means "use the preset's list".**

FlowZa employee fields: `employeeNumber`, `civilId`, `firstName`, `middleName`, `lastName`, `displayName`, `displayNameAr`,
`gender`, `dateOfBirth`, `nationalityCode`, `email`, `phone`, `joiningDate`, `exitDate`, `employmentStatus`, `employmentType`,
`branchCode`, `departmentCode`, `designationCode`, `managerEmployeeNumber`, `deviceUserId`, `cardNumber`.
Org-unit fields: `code`, `name`, `nameAr`, `parentCode`, `branchCode`, `managerEmployeeNumber`, `status`.

**Generic preset**: no mapping — the HR system sends FlowZa's own field names.

**Mawred Plus preset** — Mawred Plus does **not** publish its export field names. The preset is a *starting mapping* of the
fields an Omani government HR record typically carries; check the names your own Mawred Plus extract or middleware uses and
edit the mapping before going live:

| Typical Mawred Plus field (preset name) | FlowZa field |
|---|---|
| Civil ID (`CivilID`) | `civilId` — stored as the employee's *civil_id* identity document (sensitive) |
| Employee number (`EmployeeNo`) | `employeeNumber` — the key of the upsert |
| English first / middle / last / full name (`FirstNameEn`, `MiddleNameEn`, `LastNameEn`, `FullNameEn`) | `firstName`, `middleName`, `lastName`, `displayName` |
| Arabic full name (`FullNameAr`) | `displayNameAr` |
| Gender, birth date, nationality, e-mail, mobile (`Gender`, `BirthDate`, `NationalityCode`, `Email`, `MobileNo`) | `gender`, `dateOfBirth`, `nationalityCode`, `email`, `phone` |
| Hire date, service end date (`HireDate`, `ServiceEndDate`) | `joiningDate`, `exitDate` |
| Employment status (`EmploymentStatus`) | `employmentStatus` (values: على رأس العمل / Active → active, في إجازة → on_leave, موقوف → suspended, منتهية خدماته / متقاعد / Terminated / Retired → terminated, مستقيل / Resigned → resigned) |
| Contract type (`ContractType`) | `employmentType` (دائم / Permanent → full_time, عقد → contract, مؤقت → temporary, متدرب → intern) |
| Work location (`WorkLocationCode`) | `branchCode` (FlowZa branch code) |
| Organisational unit (`OrgUnitCode`) | `departmentCode` (the unit's code, as sent to `…/org-units`) |
| Job title (`JobTitleCode`) | `designationCode` |
| Line manager's employee number (`ManagerEmployeeNo`) | `managerEmployeeNumber` |
| Org unit: `UnitCode`, `UnitNameEn`, `UnitNameAr`, `ParentUnitCode`, `WorkLocationCode`, `UnitHeadEmployeeNo` | `code`, `name`, `nameAr`, `parentCode`, `branchCode`, `managerEmployeeNumber` |

Values are cleaned the same way as an import file: dates `YYYY-MM-DD`, `DD/MM/YYYY` or ISO date-times; enum labels are
lower-cased with spaces as underscores (`Full Time` → `full_time`). Codes (branch, department, designation) must exist in
FlowZa Time **when the employee batch is received** (records are validated on arrival): send the org units first and wait
until their batch is `COMPLETED` (§2, batch status) before sending the employees that refer to new units.

## 4. What applying a batch does (worker `EXECUTE_IMPORT`)

The same handler applies an upload confirmed on the import page and an HRMS batch, in the organisation's system context,
100 records per transaction (each record in a savepoint: one failing never fails the others), idempotently (a retried job
skips the records already applied or failed):

- **New employee**: created with an auto-assigned device user id when none is given, employment history "Joined", the civil
  ID as an identity document, `employee.created` event + audit; pushed to the terminals (`PUSH_EMPLOYEES`, when automatic
  push is on) and its attendance calculated from the joining date (`RECALCULATE_RANGE`, at most the last 366 days). The user
  limit is checked again for each new active employee.
- **Existing employee**: the fields of the record change; branch / department / designation / manager / status / contract
  changes start a new employment-history record (today, or the exit date for a leaver). A status that becomes
  **terminated / resigned** sets the exit date (today when the record has none), suspends the logins linked to the employee,
  ends their sessions, revokes pending invitations and takes the employee off **every terminal** they are enrolled on
  (`DELETE_EMPLOYEE` sync items) — the rules of the employee page. An owner's login is never ended by an import: that record
  fails with the reason. Re-activating a leaver counts against the user limit.
- **Managers** named by employee number that the same batch creates are linked in a second pass (a link that would make a
  loop in the reporting line is refused by the database and reported on the record).
- **Org units**: created / updated by code (audited `department.created` / `department.updated`); parents linked in the
  second pass with the loop check.
- The import ends `COMPLETED` with its summary and an `employee.import_completed` audit row. The `employee.imported`
  notification goes to the importers for uploads, and for HRMS batches only when records failed (a feed that runs every hour
  does not notify every hour). Every write of a batch is audited as the API key (`actor_type = API_KEY`, its prefix).

## 5. Security

- Keys: ≥ 256 bits of randomness, only the sha256 stored (`api_keys.key_hash`), compared with `timingSafeEqual`; looked up by
  their public prefix through `app.api_key_candidates` (platform context, returns that prefix's rows only); never logged,
  audited or returned after creation. Creating and revoking are audited (`integration.api_key_created` /
  `integration.api_key_revoked`). `api_keys` is readable and writable with `integration.manage` only (RLS).
- The organisation always comes from the key. A key of organisation A cannot read or write anything of organisation B
  (a batch id of B answers 404).
- The inbound router is mounted before the authenticated API (no user session), behind the edge gate, a per-IP and a per-key
  limiter, and a 5 MB body limit.
- Civil IDs are sensitive: an uploaded file may carry them only for holders of `employee.view_sensitive`, import rows show
  them masked (`****1234`) to everyone else, and audit rows keep the last four characters only.

## 6. Import page (files)

**Employees → Import** accepts CSV and Excel workbooks (`.xlsx`, first sheet; read by the API without any spreadsheet
library) and imports either **Employees** or **Organisational units** (the latter needs `department.manage`; template:
`code,name,nameAr,parentCode,branchCode,managerEmployeeNumber,status`). The employee template gained `displayNameAr`,
`civilId` and `exitDate`. With *Update existing employees*, a row of an existing employee number updates only the cells
that are filled in.
