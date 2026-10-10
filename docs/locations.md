# Location hierarchy

Customer-named location levels and one tree of locations per organisation — e.g. **Headquarters → Branch 1, 2, 3, 5 →
Site A, B, C → Floor → Zone** — following the established patterns: workforce-management "business structures" (an ordered
list of customer-named level types, then a tree of nodes on those levels), the building standard ISO 16739 (IFC: Site →
Building → Storey → Space, zones grouping spaces), IEC 62264 / ISA-95 for plants (Enterprise → Site → Area → Work centre →
Work unit) and access-control "areas" (terminals bound to a node). Decision record: [ADR-009](adr/ADR-009-location-hierarchy.md).

## 1. Model

```
Organisation
 └─ group levels (0..n)      "Headquarters", "Region", "Country"…   grouping only — no timezone, no devices
     └─ the BRANCH level (1)  "Branch" / "Store" / "Site" / "Hospital"…   = today's branches (operating unit)
         └─ place levels (0..n) "Site", "Building", "Floor", "Zone", "Line", "Ward", "Post"…   physical places in a branch
```

- **Levels** (`location_levels`): 1–8 per organisation, ordered by `position` (1 = top), each with a customer name in
  English and Arabic and an icon. Exactly one level has role `branch`: it is the **operating unit** and keeps everything a
  branch does today (timezone, holiday calendar, weekly offs, devices, data-access scope, payroll). Levels above it have
  role `group`, levels below it role `place`. Every organisation starts with one level, **Branch / فرع** (today's
  behaviour); a migration backfills it and a trigger seeds it for new organisations.
- **Locations** (`locations`): one tree per organisation (adjacency list `parent_id` + materialised `path` = ids from the
  root to the node, maintained by triggers). Three kinds of node, the role of their level:
  - `group` nodes — e.g. "Muscat HQ", "Northern Region". Code + name (en/ar).
  - `branch` nodes — **one per branch, created by a trigger when the branch is created** (backfilled for existing ones).
    Name, code and status live on the branch row; the node only places the branch in the tree (`parent_id` = a group
    node or null).
  - `place` nodes — e.g. "Site A", "Floor 2", "Zone C". Code + name (en/ar), optional GPS point. They always sit under
    their branch (`branch_id` = the ancestor branch, maintained by the trigger).
- Branches keep their table and every one of the ~40 tables that reference them is unchanged, as is the RLS branch scope
  (`app.allowed_branch_ids()`): the hierarchy is additive.

### Rules (enforced by the database, mirrored by the API with clear errors)
| Rule | |
|---|---|
| A child's level is deeper (higher `position`) than its parent's | levels may be skipped: Branch 5 can hold floors with no site |
| group nodes sit under group nodes (or at the top) | branch nodes under a group node (or at the top) |
| place nodes sit under their branch node or a place node of the same branch | never at the top |
| No cycles; at most 8 levels; at most 10 000 locations per organisation | |
| Codes are unique among siblings (case-insensitive) | the API derives one from the name when it is omitted |
| A level's role never changes; levels are renamed freely, inserted anywhere (role = above / below the branch level), deleted only when no location uses them; the branch level cannot be deleted | |
| A template replaces the level list only while the organisation has no group / place locations | |
| A place moves to another branch only when nothing (device, employee, geofence, coverage target, policy) refers to it or below it | composite foreign keys `(location_id, branch_id)` make this structural |
| Changing a device's / employee's / geofence's branch clears its location when the location belongs to the old branch | BEFORE UPDATE triggers — no writer of `branch_id` can break the composite key |
| A location is archived, never deleted; archiving refuses while it has active children or is used by an active device, employee or geofence | branch nodes follow their branch |

### Templates (`LOCATION_TEMPLATES`, @flowza/contracts)
| Key | Levels (role) | Standard |
|---|---|---|
| `SIMPLE` | Branch | today's behaviour (default) |
| `CORPORATE` | Headquarters (group) → Branch → Site → Floor → Zone | |
| `REGIONAL` | Headquarters → Region (groups) → Branch → Site → Floor → Zone | |
| `RETAIL` | Region (group) → Store → Section | |
| `FACILITIES` | Site → Building → Floor → Zone | ISO 16739 (IFC) spatial structure |
| `MANUFACTURING` | Site → Area → Line → Station | IEC 62264 / ISA-95 equipment hierarchy |
| `HEALTHCARE` | Hospital → Building → Floor → Ward | |
| `EDUCATION` | Campus → Building → Floor → Room | |
| `SECURITY_SERVICES` | Region (group) → Client site → Post | guarding companies |

A template is a starting point: every level is renamed freely afterwards (English and Arabic).

## 2. Where the tree is used

| Feature | Plan | How |
|---|---|---|
| Levels, templates, the tree, branch placement (`parentLocationId`) | all | Organisation → Locations |
| Device location (`devices.location_id`) | all | a place of the device's branch — replaces the `floor-2` tag workaround |
| Employee work location (`employees.work_location_id`) | all | a place of the employee's branch (current, not effective-dated; audited) |
| Geofence location (`geofences.location_id`) | all | the place a fence outlines (fence must have a branch) |
| `locationId` filters: employees, devices, geofences, dashboard, reports | all | a group / branch node → its branches; a place node → work locations / device locations in its subtree |
| Member branch scope "by location" | all | the member dialog selects every branch under a group node (stored as explicit branches; branches added later are added to the member explicitly) |
| Attendance policy scope by location (`attendance_rule_sets.location_id`) | Enterprise (`attendance_policies`) | §3 |
| Coverage target per location (`shift_coverage_requirements.location_id`) | Enterprise (`advanced_scheduling`) | scheduled = employees on the shift whose work location is in the subtree |
| Muster list ("last seen here today") | Enterprise (`advanced_scheduling`) | §4 |

## 3. Policy resolution with locations

The policy's *where* is one of: nothing, a country, a branch (`branch_id`), a group location (`location_id`, `branch_id`
null) or a place location (`location_id` + `branch_id` = the place's branch, kept consistent by a composite FK). The
employee's location chain on the date is the path of their work location when it belongs to the branch they work in on
that date, else the path of that branch's node. A location policy applies when its location is on the chain.

Specificity keeps the published weights (shift 32 > employee group 16 > department 8 > location/branch 4 > country 2;
`policySpecificity`), and ties between location policies go to the **deeper** location (Zone > Floor > Site > Branch >
Region > HQ) before the effective date — so a Site A policy beats the Branch 1 policy for the people on Site A, and every
ordering between existing policies is unchanged.

## 4. Muster list

`GET /orgs/:orgId/locations/:id/muster?date=` — for every employee whose **latest** non-voided attendance event on the date
(the branch's local date) was punched on a terminal placed in the location's subtree: the employee, the event, the
terminal and its location. `PUNCH_IN` / `BREAK_END` = on site, `BREAK_START` = on break, `PUNCH_OUT` = left, `PUNCH` =
seen (direction unknown). Plus the same counts per direct child location (drill-down). Portal (web/mobile) punches carry
no terminal and are not attributed to a place.

## 5. API (`/api/v1/orgs/:orgId/…`)

| Method & path | Permission | |
|---|---|---|
| `GET location-levels` | `branch.view` | ordered levels |
| `POST location-levels` | `branch.manage`, every branch | `{ name, nameAr?, icon?, position }` → the whole list (positions shift) |
| `PATCH location-levels/:id` | same | `{ name?, nameAr?, icon? }` |
| `DELETE location-levels/:id` | same | unused, not the branch level → the whole list |
| `POST location-levels/apply-template` | same | `{ template }` → the whole list |
| `GET locations` | `branch.view` | the whole visible tree (flat, with `path`, counts rolled up) |
| `GET locations/:id` | `branch.view` | node + breadcrumb |
| `POST locations` | `branch.manage` (group: every branch; place: the branch in scope) | `{ levelId, parentId?, code?, name, nameAr?, latitude?, longitude? }` |
| `PATCH locations/:id` | same | rename / move (`parentId`) / re-level / restore; branch nodes: `parentId` only |
| `DELETE locations/:id` | same | archive |
| `GET locations/:id/muster` | `attendance.view` + module `advanced_scheduling` | §4 |

Errors: `VALIDATION_ERROR` (shape / parent / level rules), `CONFLICT` (in use, nodes exist for a template, cross-branch
move of a referenced place, the branch level), `NOT_FOUND`.

## 6. Security

- RLS (custom policies, not the generator): read = `branch.view` in the organisation and (every branch, or a group node, or
  a node of an allowed branch). Write = `branch.manage` and (every branch, or a **place** of an allowed branch) — a
  branch-scoped administrator manages the sites / floors / zones of their branches but never group nodes, branch
  placement or the levels (levels: `branch.manage` + every branch).
- Trigger functions are `SECURITY DEFINER` with an empty `search_path`; they validate the shape from the level and the
  parent and never trust `role`, `branch_id` or `path` sent by a client.
- Tenant key immutable, RLS forced, no data API (`app.enforce_tenant_table`), covering indexes for every foreign key.

## 7. Not in this release (follow-ups)

- Re-labelling the fixed word "Branch" across every screen with the organisation's branch-level name.
- Dynamic region-scoped access (a member granted a group node automatically gets branches added under it later).
- Effective-dated work-location history; work location in the employee import; portal punches attributed to a place via
  geofence.
