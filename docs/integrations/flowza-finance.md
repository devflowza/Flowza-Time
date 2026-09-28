# Flowza Finance connector

Two-way attendance sync between **FlowZa Time** and **Flowza Finance** (HR+ Attendance), at punch level, on one credential.

- **Pull (Finance → FlowZa Time).** Punches Finance received from its own terminals, the Finance employee portal or other
  agents are fetched from Finance's `attendance-export` function and processed by FlowZa Time like punches from any device.
- **Push (FlowZa Time → Finance).** Punches recorded in FlowZa Time (terminals, mobile check-ins, imports, corrections) are
  sent to Finance's `attendance-ingest` function.
- **One credential.** FlowZa Time is registered in Finance as one *virtual attendance device*. Its **serial** and **push
  token** authenticate both directions.
- **Nothing echoes.** Punches that came from Finance — and FlowZa Time's edits of them — are never pushed back, and Finance
  never exports the punches FlowZa Time pushed.

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
| **Enable the connector** | On. When off nothing is pulled or pushed; the settings, the stored token and the sync position are kept. |
| **Finance functions base URL** | Leave the default `https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1` unless Finance tells you otherwise. Must be `https` on a public host (see §6). The *Ingest endpoint* Finance shows is this address followed by `/attendance-ingest`. |
| **Finance device serial** | The serial from step 1 (`FLOWZA-TIME-…`). |
| **Finance push token** | The token from step 1. It is stored encrypted and never shown again — the page only shows its last characters. |
| **Direction** | **Both directions** (default), **Pull only** or **Push only**. *Push only* never reads Finance — not on schedule, not from **Sync → attendance** (even "all devices"), not from the device page. *Pull only* never sends anything. |
| **Employee identity (PIN)** | Which employee field is **sent** to Finance as the PIN: **Employee number** (default — this is what Finance's auto-map expects), **Device user ID** or **Card number**. It does not affect how pulled punches are matched (§3). |
| **Sync every (min)** | 5–60 minutes between pulls and between pushes (default 10). Finance shows the device *Online* when it was contacted in the last 5 minutes and *Stale* up to 60 minutes. |
| **Synchronise from** | The start date (default: 30 days before the day the connector is set up, in your organisation's timezone). Punches before it are never synchronised in either direction, and the first pull and the first push start there — switching the connector on does not replay years of history. It cannot be in the future. |

Click **Test connection**. It asks Finance for one punch and shows Finance's clock and the date of the first punch Finance holds
(or "No punches in Finance yet"). Then **Save**, and **Sync now** if you do not want to wait for the first scheduled run.
Only one push runs per connector at a time: a **Sync now** that finds a push already running waits for it (up to two minutes)
and then sends what that run could not see, so a punch recorded a moment ago is not left for the next scheduled run.

**Changing the start date later.** Moving it **earlier** re-reads Finance and re-sends FlowZa Time's punches from the new date;
both systems skip the punches they already hold, so nothing is duplicated. Moving it **later** only narrows what is synchronised
from then on — nothing already exchanged is removed.

**Changing the serial or the base URL** makes it a different Finance device: FlowZa Time asks for that device's token (the stored
one belonged to the old device and is never sent to the new one — when you save a *disabled* connector without a token, the old
token is deleted), starts reading the new Finance from the start date, sends it every punch from the start date, and abandons
runs that were in progress. Punches FlowZa Time pushed under the old serial are recognised as its own if they come back.

## 3. How employees are matched

The employee number must be spelled the same in both systems (`EMP-0042` is not `0042`; case and surrounding spaces are
ignored).

- **Push.** Each punch carries the employee's PIN field (employee number by default). Finance attributes it through its PIN
  mapping; with *Auto-map PINs to employee numbers* on, a PIN equal to an employee number is mapped automatically on arrival.
  Punches Finance cannot map appear in Finance under **Workforce Config → Unmapped Punches**, where they can be assigned (and
  are back-filled). Employees without a value in the chosen field (for example no card number when *Card number* is selected)
  are skipped and counted.
- **Pull.** A Finance punch is attributed **only by its employee number**: Finance's employee number against FlowZa Time's, in
  your organisation, never to an employee who is terminated or resigned. The *Employee identity (PIN)* choice plays no part.
  A punch Finance itself could not attribute (an unmapped PIN on one of Finance's own terminals) arrives without an employee
  number and is kept as **unmatched** — it is never matched to a FlowZa Time device user ID or card number, because a PIN on a
  Finance terminal belongs to that terminal's numbering, not to FlowZa Time's. The status card in Settings → Integrations shows
  how many punches are unmatched, and clicking it opens **Attendance → Raw punches** filtered to them. Keep the PINs of Finance's
  own terminals mapped in Finance (**Workforce Config → PIN Mapping**): a punch pulled before Finance attributed it stays
  unmatched in FlowZa Time.

## 4. What is sent, and what is not

| | Included | Not included |
|---|---|---|
| **Push** | Punches from terminals, mobile / self-service check-ins, imports, and corrections that add or move a FlowZa Time punch | Manual attendance entries (HR bookkeeping, not punches); punches voided by a correction; status corrections (a day marked present or absent is a verdict, not a punch); anything that came from Finance **and any edit of it**; punches dated before the start date |
| **Pull** | Every punch Finance holds for your organisation from the start date on — its terminals, its employee portal, other agents, imports | The punches FlowZa Time pushed (Finance filters them out, and FlowZa Time drops anything carrying its own serial, current or previous); punches before the start date |

Pushes go in the order FlowZa Time recorded the punches, at most 500 per request, and are safe to repeat: Finance ignores a
punch it already has, and FlowZa Time keeps a record of what it sent, so a punch recorded while a sync was running is still sent
on the next run, and never twice. A punch that FlowZa Time later **voids** through a correction is **not** removed in Finance
(Finance has no way to receive a removal yet) — correct it in Finance as well.

**When Finance does not store everything it is sent.** Finance can answer a request and still report that some punches could not
be stored. FlowZa Time does not count such a batch as delivered: it sends the same batch again a few minutes later (Finance
ignores the punches it did store). After **5 attempts** the batch is skipped so the connector does not stall, and the people who
manage integrations are notified ("Flowza Finance push skipped punches it could not store"). Those punches are not in Finance: fix the cause in Finance,
then move the start date back to before them — they are sent again.

## 5. Status and problems

The **Sync status** card (Settings → Integrations) shows the connection, the last pull and the last push with their counts, the
number of consecutive failures and the last error, a batch being retried ("attempt 2 of 5"), the unmatched punches, and the
recent sync jobs (each links to its details in **Sync**). Pulls and pushes are ordinary sync jobs, so they are also listed on the
Sync page, and the connector appears in the device list as *Flowza Finance connector* (its settings can only be changed here;
the device page's edit, credentials, test-connection and reconcile actions refuse it).

After **3 consecutive failures** in either direction, everyone who can manage integrations is notified ("Flowza Finance … is
failing") — once per run of failures; a new notification comes only after a successful exchange with Finance. Only an actual
answer from Finance ends a run of failures: a scheduled push with nothing to send does not hide a failing pull. Repeated failures
also pause calls to Finance for a while (circuit breaker, per organisation); the card shows when the next attempt happens.

A temporary problem — Finance or a gateway answering with an error page, a redirect or an unreadable answer — fails that run,
which is retried with growing pauses; the connector never loses its place, so nothing is skipped. Connection problems are
reported in general terms (*unreachable*, *the secure connection could not be established*, *did not answer in time*, *refused:
the address must be https on a public host*); the details are in the server logs, not on the page.

| Symptom (on the card) | Cause | What to do |
|---|---|---|
| **Credential rejected** | Serial or token wrong, the token was regenerated in Finance, or the device is disabled in Finance | Check the device in Finance; click **Replace** next to the token, paste the current token, **Save** |
| **Finance error** "…was not found at the configured base URL" | Wrong base URL (or Finance's functions are down) | Use the default URL above (or the one Finance gave you); it is retried automatically meanwhile |
| Saving answers "Finance base URL must point at a public host" | The address is not `https`, names a private or local host, or resolves to a private address | Use Finance's public functions URL |
| Many **unmatched** punches | Employee numbers differ between the systems, or Finance has unmapped PINs on its terminals | Align the employee numbers; map the PINs in Finance |
| Finance shows punches under **Unmapped Punches** | The PIN sent is not an employee number in Finance | Turn on *Auto-map PINs to employee numbers* in Finance or map the PINs there; check the **Employee identity (PIN)** choice |
| "…push skipped punches it could not store" notification | Finance kept refusing some punches of a batch 5 times | Check Finance's logs for those punches; then move the start date back to re-send them |

**Rotating the token:** in Finance, edit the device → **Regen** → **Save**; then in FlowZa Time click **Replace** next to the
token, paste the new one and **Save**. Both directions fail until the new token is saved in FlowZa Time.

**Switching it off:**

- **Enable the connector** off (FlowZa Time): nothing is pulled or pushed; token, settings and position are kept, so switching it
  back on continues where it stopped.
- **Disconnect** (on the Sync status card, after a confirmation): the connector stops, its **token is deleted** and its sync
  position is forgotten; the settings stay. Punches already exchanged stay in both systems. To reconnect, enter a push token and
  **Save** — reading and sending start again from the start date (both sides skip duplicates).
- The device's **Enabled** toggle in Finance refuses both directions immediately.

## 6. Security

- The token is stored encrypted in FlowZa Time's credential store, is never returned to a browser (only masked, like
  `****cdef`) and never written to logs or audit entries.
- The base URL must be `https` on a public host. It is checked when you save or test it and on every call: private, loopback,
  link-local and similar addresses — written as numbers in any form, or behind a name that **resolves** to one — and local names
  (`localhost`, `*.local`, `*.internal`, `*.lan`, single-word names, …) are refused; the connection is made to the address that was
  checked, redirects are not followed and answers are capped at 16 MB.
- A connection test reuses the stored token only for the saved base URL and serial, so it can never be aimed at another address.
- Only holders of **Manage integrations** can configure, test, sync or disconnect the connector, open its status card, or receive
  its failure notifications — checked by the application and again by the database for every request. People who can see devices
  see the connector in the device list (its token masked, never in clear) and its sync jobs.

## 7. Limits

- Voided punches are not removed in Finance (see §4).
- A Finance punch pulled before Finance attributed it stays unmatched in FlowZa Time (see §3).
- A batch Finance keeps refusing is skipped as a whole after 5 attempts (Finance's answer does not say which punch it refused).
- The connector does not send employees to Finance and does not read Finance's employee list.
