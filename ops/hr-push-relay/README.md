# hr.flowza.ai → FlowZa Time push relay

The attendance terminals have a single Cloud Server setting each and already push to the existing HR system at
`hr.flowza.ai`, so FlowZa cannot be added as a second destination on the device. This Cloudflare Worker sits in front
of `hr.flowza.ai/iclock/*` and sends each ADMS request to both systems. Nothing changes on the terminals.

While `PRIMARY = "hr"`:

- the HR system answers every request exactly as it does today — same handshake options, same commands, same stamps;
- FlowZa receives a copy of the same bytes, after the answer has gone out, in `waitUntil`;
- a FlowZa outage, a bad token or a timeout can never delay or break a punch reaching the HR system.

The terminal only ever sees the primary's answer, because the ADMS handshake *configures* the device and `getrequest`
carries server→device commands: two answers would fight over it. So while the HR system is primary, FlowZa's own
device commands (push employees, remote restart) do not reach the terminal — this mode is data capture only.

## Deploy

```bash
cd ops/hr-push-relay
npx wrangler deploy
npx wrangler secret put DEVICE_TOKENS     # {"ZK-99887766":"<push token>"}
npx wrangler tail                          # live view of what the terminals are doing
```

`HR_UPSTREAM` must be the HR system's **origin** hostname, not `hr.flowza.ai` — a subrequest to the Worker's own route
can loop back into the Worker. Add a separate DNS record (grey-clouded, or simply not covered by the route) for the
same server, e.g. `hr-origin.flowza.ai`.

## Bringing a terminal into FlowZa

1. **Deploy the relay.** With `MIRROR_UNKNOWN = "true"` every terminal that talks to `hr.flowza.ai` is mirrored to
   FlowZa without a token. FlowZa does not know the serial yet, so it lists it under **Devices → pending devices**. It
   answers handshakes (the terminal keeps polling) but refuses data uploads, so nothing is stored under a serial nobody
   has claimed — and the HR system is unaffected throughout.
2. **Claim the device** in FlowZa: pick its branch and name. The push token is displayed **once** — copy it.
3. **Add the token** to `DEVICE_TOKENS` (`wrangler secret put DEVICE_TOKENS` with the full JSON map) and redeploy.
   Punches now land in FlowZa as raw transactions.
4. **Match the people.** Punches attach to employees by device user ID (PIN). A punch whose PIN has no employee is
   stored with status `unmatched` under Attendance → Raw transactions — kept, but not counted. Create the employees
   with the matching device user ID (or import them), then recalculate to pick those rows up.
5. **Cut over** when you are ready: set `PRIMARY = "flowza"`. FlowZa now answers and drives the terminals, and the HR
   system keeps receiving a copy until you set `MIRROR_TO_HR = "false"`. Serials with no token stay on the HR system
   regardless, so an unclaimed terminal is never stranded by the switch.

Re-sends are safe at every step: FlowZa deduplicates on a hash of device, generation, device user id, timestamp,
verification and direction, so a terminal replaying its backlog (or the relay retrying) never doubles a punch.

## What this does not do

- **History already in the HR system.** The relay only mirrors traffic from the moment it is deployed. Punches the
  terminals delivered before that are in the HR system's database, and FlowZa has no attendance-import path today —
  moving them across needs a one-off backfill.
- **Two-way device management.** See the primary/answer note above.
