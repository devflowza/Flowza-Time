// FlowZa Time · portal videos · explainer cards (HTML rendered in the recording browser): the two site layouts and the day
// timeline of the time-away video, and the closing summary card.
const shell = (body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font-family:Inter,system-ui,sans-serif;background:#f6faf8;color:#0b1f19}
.wrap{height:100%;box-sizing:border-box;padding:56px 72px;display:flex;flex-direction:column}
.eyebrow{text-transform:uppercase;letter-spacing:3px;font-size:14px;color:#0f766e;font-weight:700}
h1{margin:8px 0 28px;font-size:40px;letter-spacing:-.5px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:36px;flex:1}
.panel{background:#fff;border:1px solid #d7e7e0;border-radius:22px;padding:28px 30px;box-shadow:0 10px 30px rgba(15,118,110,.07)}
.panel h2{margin:0 0 6px;font-size:26px}.panel p{margin:0 0 18px;color:#3f5f55;font-size:18px;line-height:1.45}
.row{display:flex;align-items:center;gap:14px;margin:12px 0;font-size:18px}
.dev{flex:none;width:58px;height:58px;border-radius:14px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:15px}
.in{background:#059669}.out{background:#b45309}.both{background:#0f766e}.portal{background:#2563eb}.acc{background:#7c3aed}
.arrow{color:#94a3b8;font-size:22px}
.tl{margin-top:18px;background:#fff;border:1px solid #d7e7e0;border-radius:22px;padding:24px 30px}
.bar{position:relative;height:46px;border-radius:12px;overflow:hidden;display:flex;margin:14px 0 8px}
.seg{height:100%;display:grid;place-items:center;color:#fff;font-weight:700;font-size:15px}
.ticks{display:flex;justify-content:space-between;color:#64748b;font-size:14px}
.legend{display:flex;gap:22px;flex-wrap:wrap;margin-top:12px;font-size:16px;color:#334155}
.legend span:before{content:'';display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:8px;vertical-align:-1px;background:var(--c)}
${extra}</style></head><body><div class="wrap">${body}</div></body></html>`;

export function layoutsCard() {
  return shell(`<div class="eyebrow">Between check-in and check-out</div><h1>Two kinds of site, one answer</h1>
  <div class="cols">
    <div class="panel"><h2>1 · Two-way terminals</h2><p>IN / OUT keys, or separate exit and entry gates. Leaving and returning are punches.</p>
      <div class="row"><div class="dev both">IN/OUT</div><span>08:00 <b>IN</b> on the lobby terminal</span></div>
      <div class="row"><div class="dev out">EXIT</div><span>10:00 <b>OUT</b> — leaves for a client visit</span></div>
      <div class="row"><div class="dev in">ENTRY</div><span>12:05 <b>IN</b> — back on site</span></div>
      <div class="row"><div class="dev both">IN/OUT</div><span>14:00 <b>OUT</b> — end of the day</span></div>
    </div>
    <div class="panel"><h2>2 · Entry terminal only</h2><p>The terminal is only at the entrance. The portal records the step-out; the terminal records the return.</p>
      <div class="row"><div class="dev in">ENTRY</div><span>08:00 <b>IN</b> on the entrance terminal</span></div>
      <div class="row"><div class="dev portal">PORTAL</div><span>10:00 <b>Step out</b> — official duty, back 12:00</span></div>
      <div class="row"><div class="dev in">ENTRY</div><span>12:05 <b>IN</b> — or “I’m back” in the portal</span></div>
      <div class="row"><div class="dev portal">PORTAL</div><span>14:00 <b>Check out</b> in the portal</span></div>
    </div>
  </div>
  <div class="tl"><b style="font-size:18px">The same day, either way</b>
    <div class="bar"><div class="seg" style="flex:120;background:#059669">On site 2h</div><div class="seg" style="flex:125;background:#2563eb">Official duty 2h 05m</div><div class="seg" style="flex:115;background:#059669">On site 1h 55m</div></div>
    <div class="ticks"><span>08:00</span><span>10:00</span><span>12:05</span><span>14:00</span></div>
    <div class="legend"><span style="--c:#059669">On site</span><span style="--c:#2563eb">Official duty (worked)</span><span style="--c:#d97706">Permission (excused)</span><span style="--c:#dc2626">Unapproved</span><span style="--c:#7c3aed">Meeting-room reader: never splits the day</span></div>
  </div>`);
}

export function rulesCard() {
  return shell(`<div class="eyebrow">The rules, in one place</div><h1>Every gap between the first IN and the last OUT is classified</h1>
  <div class="cols" style="grid-template-columns:1fr 1fr 1fr;gap:22px;flex:none">
    <div class="panel"><h2 style="color:#2563eb">Official duty</h2><p>Inside an approved official window (+10 min grace). Counts as worked time.</p></div>
    <div class="panel"><h2 style="color:#d97706">Permission</h2><p>Inside an approved personal window. Unpaid, excused, up to 4 h a month.</p></div>
    <div class="panel"><h2 style="color:#dc2626">Unapproved</h2><p>No approval, beyond the shift's break. Deducted; flagged after 15 minutes.</p></div>
    <div class="panel"><h2 style="color:#0f766e">Break</h2><p>The shift's break allowance is used first, in time order.</p></div>
    <div class="panel"><h2 style="color:#64748b">Short gaps</h2><p>Under 5 minutes stays worked time — a step outside the reader's reach.</p></div>
    <div class="panel"><h2 style="color:#7c3aed">Meeting rooms</h2><p>ACCESS readers record room entries for meeting attendance — never attendance punches.</p></div>
  </div>`);
}
