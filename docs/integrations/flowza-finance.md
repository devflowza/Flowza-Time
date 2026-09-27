# Flowza Finance connector

Two-way attendance sync between **FlowZa Time** and **Flowza Finance** (HR+ Attendance), at punch level, on one credential.

- **Pull (Finance → FlowZa Time).** Punches Finance received from its own terminals, the Finance employee portal or other
  agents are fetched from Finance's `attendance-export` function and processed by FlowZa Time like punches from any device.
- **Push (FlowZa Time → Finance).** Punches recorded in FlowZa Time (terminals, mobile check-ins, imports, corrections) are
  sent to Finance's `attendance-ingest` function.
- **One credential.** FlowZa Time is registered in Finance as one *virtual attendance device*. Its **serial** and **push
  token** authenticate both directions.
- **Nothing echoes.** Punches that came from Finance are never pushed back, and Finance never exports the punches FlowZa Time
  pushed.

You need the **Manage integrations** permission (`integration.manage`; owners and organisation admins have it by default) in
FlowZa Time, and permission to manage Workforce devices in Finance (`hrms.workforce_devices.manage`).

---

## 1. Register FlowZa Time as a device in Finance

In **Flowza Finance**:

1. Sidebar → **Workforce** → **Devices & Punches** → **Devices** → **Add device** (also available at
   `/hrms/workforce-config`).
2. Fill the drawer:
   - **Friendly name:** `FlowZa Time`.
   - **Serial / SN:** `FLOWZA-TIME-<company code>`, for example `FLOWZA-TIME-MANCHI`. Keep it unique per company; the serial
     and the token together are the whole credential.
   - **Connection method:** **LAN Agent / REST**. Brand and model can stay empty.
   - **Device timezone:** your company's timezone (for example `Asia/Muscat`). FlowZa Time always sends UTC times, so this only
     matters for times sent without a timezone.
   - **Auto-map PINs to employee numbers (connector devices):** **tick it.** It appears under *Connection settings* once the
     method is LAN Agent / REST. With it, Finance attributes each pushed punch to the employee whose employee number equals the
     PIN, instead of waiting for someone to map the PIN by hand.
3. **Save.** Finance generates the token and shows three copy fields under *Connection settings*: the **Ingest endpoint**,
   the **device_serial** and the **token**. Copy the serial and the token.

Treat the token as a password: whoever holds the serial and the token can read every punch of your organisation in Finance
and write punches into it.

## 2. Connect it in FlowZa Time

In **FlowZa Time**: **Settings → Integrations**.

| Field | What to enter |
|---|---|
| **Enable the connector** | On. When off nothing is pulled or pushed; the settings and the stored token are kept. |
| **Finance functions base URL** | Leave the default `https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1` unless Finance tells you otherwise. Must be `https`. The *Ingest endpoint* Finance shows is this address followed by `/attendance-ingest`. |
| **Finance device serial** | The serial from step 1 (`FLOWZA-TIME-…`). |
| **Finance push token** | The token from step 1. It is stored encrypted and never shown again — the page only shows its last characters. |
| **Direction** | **Both directions** (default), **Pull only** or **Push only**. |
| **Employee identity (PIN)** | Which employee field is sent to Finance as the PIN and matched when pulling: **Employee number** (default — this is what Finance's auto-map expects), **Device user ID** or **Card number**. |
| **Sync every (min)** | 5–60 minutes between pulls and between pushes (default 10). Finance shows the device *Online* when it was contacted in the last 5 minutes and *Stale* up to 60 minutes. |

Click **Test connection**. It asks Finance for one punch and shows Finance's clock and the date of the first punch Finance holds
(or "No punches in Finance yet"). Then **Save**, and **Sync now** if you do not want to wait for the first scheduled run.

## 3. How employees are matched

The employee number must be spelled the same in both systems (`EMP-0042` is not `0042`).

- **Push.** Each punch carries the employee's PIN field (employee number by default). Finance attributes it through its PIN
  mapping; with *Auto-map PINs to employee numbers* on, a PIN equal to an employee number is mapped automatically on arrival.
  Punches Finance cannot map appear in Finance under **Workforce Config → Unmapped Punches**, where they can be assigned (and
  are back-filled). Employees without a value in the chosen field (for example no card number when *Card number* is selected)
  are skipped and counted.
- **Pull.** Each Finance punch arrives with Finance's employee number (or, when Finance itself has not mapped the PIN yet, the
  PIN of the Finance device that recorded it). FlowZa Time matches it against the same employee field, case-insensitively, then
  against the device-user mappings made in reconciliation. A punch that matches nobody is kept as **unmatched**: the status card
  in Settings → Integrations shows how many, and clicking the card opens **Attendance → Raw punches** filtered to them.

## 4. What is sent, and what is not

| | Included | Not included |
|---|---|---|
| **Push** | Punches from terminals, mobile / self-service check-ins, imports and corrections | Manual attendance entries (HR bookkeeping, not punches); punches voided by a correction; anything that came from Finance |
| **Pull** | Every punch Finance holds for your organisation — its terminals, its employee portal, other agents, imports | The punches FlowZa Time pushed (Finance filters them out) |

Pushes go in the order FlowZa Time recorded the punches, at most 500 per request, and are safe to repeat: Finance ignores a
punch it already has. A punch that FlowZa Time later **voids** through a correction is **not** removed in Finance (Finance has
no way to receive a removal yet) — correct it in Finance as well.

## 5. Status and problems

The **Sync status** card (Settings → Integrations) shows the last pull and the last push with their counts, the number of
consecutive failures and the last error, the unmatched punches, and the recent sync jobs (each links to its details in
**Sync**). Pulls and pushes are ordinary sync jobs, so they are also listed on the Sync page, and the connector appears in the
device list as *Flowza Finance connector* (its settings can only be changed here).

After **3 consecutive failures** in either direction, everyone who can synchronise devices is notified ("Flowza Finance … is
failing"). Repeated failures also pause calls to Finance for a while (circuit breaker); the card shows when the next attempt
happens.

| Symptom | Cause | What to do |
|---|---|---|
| Test or sync fails with `AUTH_FAILED` | Serial or token wrong, the token was regenerated in Finance, or the device is disabled in Finance | Check the device in Finance; click **Replace** next to the token, paste the current token, **Save** |
| `INVALID_CONFIG` "…was not found at the configured base URL" | Wrong base URL | Use the default URL above (or the one Finance gave you) |
| Many **unmatched** punches | Employee numbers differ between the systems, or Finance has unmapped PINs | Align the employee numbers, or map the Finance PINs in reconciliation; map PINs in Finance for its own devices |
| Finance shows punches under **Unmapped Punches** | The PIN sent is not an employee number in Finance | Turn on *Auto-map PINs to employee numbers* in Finance or map the PINs there; check the **Employee identity (PIN)** choice |

**Rotating the token:** in Finance, edit the device → **Regen** → **Save**; then in FlowZa Time click **Replace** next to the
token, paste the new one and **Save**. Both directions fail until the new token is saved in FlowZa Time. When the serial or the
base URL changes, FlowZa Time asks for the token again.

**Switching it off:** turn **Enable the connector** off in FlowZa Time, or the device's **Enabled** toggle off in Finance (which
refuses both directions immediately). History is kept on both sides.

## 6. Security

- The token is stored encrypted in FlowZa Time's credential store, is never returned to a browser (only masked, like
  `****cdef`) and never written to logs or audit entries.
- The base URL must be `https` on a public host. A connection test reuses the stored token only for the saved base URL and
  serial, so it can never be aimed at another address.
- Only holders of **Manage integrations** can configure the connector or open its status card; people who can see devices see
  the connector in the device list (its token masked, never in clear) and its sync jobs.

## 7. Limits

- Voided punches are not removed in Finance (see §4).
- When Finance maps a PIN to an employee *after* FlowZa Time already pulled the punch, FlowZa Time keeps the punch as it was
  pulled (unmatched); map it in FlowZa Time's reconciliation instead. A **full re-sync** from the Sync page re-reads Finance's
  history safely (already imported punches are recognised).
- The connector does not send employees to Finance and does not read Finance's employee list.
