import { ic, LOGO, CURSOR, shell, side } from './kit.mjs';
import { av, who, chip, tag, swap, F, I, btn, sw, cb, toast, modal, mhead, scene } from './h.mjs';

const floatToast = (at, out, title, sub, extra = '') =>
  toast(at, out, title, sub).replace(
    'class="toast"',
    `class="toast float" style="right:96px;bottom:110px;${extra}"`,
  );
const shiftsHeader = (tab) => `
  <div class="ph"><div><h2>Shifts &amp; schedules</h2><p>Shifts, rotational patterns, who works which shift, and the attendance rule sets that turn punches into results.</p></div></div>
  <div class="tabs">${['Shifts', 'Patterns', 'Assignments', 'Rule sets', 'Roster', 'Shift requests'].map((t) => `<span class="${t === tab ? 'on' : ''}">${t}</span>`).join('')}</div>`;

// ---------------------------------------------------------------- 4. Changing shifts
// Shifts → Assignments → "Assign shift" (effective-dated, past dates queue a recalculation); Employees bulk "Assign shift (n)";
// the employee portal's "Request a shift change" (Enterprise module shift_requests).
export const change = () => {
  const tr = (target, type, shift, branch, eff, extra = '') =>
    `<tr ${extra}><td class="strong">${target}<small style="display:block;margin-top:2px">${tag(type)}</small></td><td>${shift}</td><td>${branch}</td><td class="tnum">${eff} ${chip('Active')}</td></tr>`;
  const winA = `${shiftsHeader('Assignments')}
    <div class="row" style="margin-bottom:12px"><div class="inp sel" style="width:170px;height:36px"><span>All targets</span></div><div class="inp sel" style="width:150px;height:36px"><span class="ph-t">Shift</span></div><span style="margin-left:auto">${btn('Assign shift', { icon: 'LuPlus', id: 'c-assign' })}</span></div>
    <div class="card"><table class="tbl"><tr><th>Target</th><th>Shift / pattern</th><th>Branch</th><th>Effective</th></tr>
      ${tr('Organisation', 'Organisation', 'General', 'All branches', '01 Jan 2026 → open')}
      ${tr('Warehouse', 'Department', 'Night', 'Muscat HQ', '11 Oct 2026 → open')}
      ${tr('Stores team', 'Team', 'Morning', 'Muscat HQ', '01 Sep 2026 → open')}
      ${tr('Said Al Mamari', 'Employee', 'Evening', 'Muscat HQ', '04 Oct 2026 → 29 Oct 2026', 'data-at="b0+5.0" data-hl="b0+5.1~b1" style="background:#f6fdf9"')}</table></div>`;
  const ovA = modal(
    'b0+0.9',
    'b0+4.8',
    'left:110px;top:110px;width:720px',
    `
    ${mhead('Assign shift', 'The most specific assignment wins: employee › team › department › branch › organisation. Overlapping ranges for the same target are rejected.')}
    <div class="grid2" style="gap:12px">${F('Assign to', I('Employee', { sel: 1 }), { req: 1 })}${F('Target', I('Said Al Mamari', { sel: 1 }), { req: 1 })}</div>
    <div class="opt-block" style="margin-top:12px"><span class="seg"><span class="on">Single shift</span><span>Rotational pattern</span></span><div style="margin-top:10px">${F('Shift', I('Evening', { sel: 1 }), { req: 1, hl: 'b0+1.4~b0+2.1' })}</div></div>
    <div class="grid2" style="gap:12px;margin-top:12px">${F('Effective from', I('04 Oct 2026', { type: 'b0+2.2', icon: 'LuCalendar', focus: 'b0+2.1~b0+3.1', id: 'c-from' }), { req: 1, hint: 'Past dates trigger a recalculation.' })}${F('Effective to (last day)', I('29 Oct 2026', { type: 'b0+3.4', icon: 'LuCalendar', focus: 'b0+3.3~b0+4.4' }), { opt: 1, hl: 'b0+3.3~b0+4.6', hint: 'Included: the assignment still applies on this day. Leave empty for no end.' })}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Assign', { id: 'c-save' })}</div>`,
  );
  const emps = [
    ['E-1031', 'Yousuf Al Hinai', 'Forklift operator', 'Warehouse'],
    ['E-1044', 'Hamed Al Busaidi', 'Driver', 'Logistics'],
    ['E-1060', 'Majid Al Shukaili', 'Forklift operator', 'Warehouse'],
    ['E-1023', 'Salim Al Harthy', 'Warehouse supervisor', 'Operations'],
    ['E-1052', 'Said Al Mamari', 'Store keeper', 'Warehouse'],
  ];
  const winB = `
    <div class="ph"><div><h2>Employees</h2><p>468 employees</p></div><div class="row">${btn('Export', { cls: 'ghost', icon: 'LuDownload' })}${btn('Import', { cls: 'ghost', icon: 'LuFileUp' })}${btn('Add employee', { icon: 'LuPlus' })}</div></div>
    <div style="position:relative;height:50px;margin-bottom:8px"><div class="row card" data-at="b1+1.0" style="position:absolute;inset:0;padding:8px 12px;background:#eefaf5;border-color:#d5f2e5;justify-content:space-between"><b style="font-size:14.5px;color:#0e4e3f">3 selected</b><div class="row" style="gap:6px">${btn('Assign…', { cls: 'ghost sm', id: 'c-bulk', icon: 'LuChevronDown' })}${btn('Sync to devices', { cls: 'ghost sm' })}${btn('Export', { cls: 'ghost sm' })}${btn('Clear selection', { cls: 'ghost sm' })}</div></div></div>
    <div class="card"><table class="tbl"><tr><th style="width:40px">${cb()}</th><th>Employee number</th><th>Name</th><th>Department</th><th>Designation</th><th>Status</th></tr>
      ${emps.map((e, k) => `<tr><td>${cb(k < 3 ? `b1+${(0.3 + k * 0.3).toFixed(1)}` : null, `c-cb${k}`)}</td><td class="mono">${e[0]}</td><td>${who(e[1], '', k + 2)}</td><td>${e[3]}</td><td>${e[2]}</td><td>${chip('Active')}</td></tr>`).join('')}</table></div>`;
  const ovB =
    `<div class="float menu" data-at="b1+1.6" data-out="b1+2.5" style="right:470px;top:196px">${[
      ['LuBuilding2', 'Assign branch (3)'],
      ['LuNetwork', 'Assign department (3)'],
      ['LuCalendarClock', 'Assign shift (3)', 'c-menu-shift'],
      ['LuUserCheck', 'Set status (3)'],
    ]
      .map(([i, l, id]) => `<div ${id ? `id="${id}" class="act"` : ''}>${ic(i)}${l}</div>`)
      .join('')}</div>` +
    modal(
      'b1+2.5',
      'b1+3.6',
      'left:200px;top:150px;width:540px',
      `
    ${mhead('Assign shift (3)', 'Closes open employee shift assignments and starts a new one.')}
    ${F('Shift', I('Evening', { sel: 1 }), { req: 1 })}
    <div class="grid2" style="gap:12px;margin-top:12px">${F('Effective from', I('11 Oct 2026', { icon: 'LuCalendar' }), { req: 1 })}${F('Effective to (last day)', I('', { icon: 'LuCalendar' }), { opt: 1 })}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Apply to 3', { id: 'c-apply' })}</div>`,
    );
  const portal = `<div class="float card" data-at="b1+3.8" data-out="b2+0.1" data-anim="left" style="left:1250px;top:380px;width:570px;padding:18px 20px;box-shadow:0 24px 48px -12px rgba(16,24,40,.35)">
      <div class="row" style="justify-content:space-between;align-items:flex-start"><b style="font-size:17px">Request a shift change</b>${chip('My shift · employee portal', 'teal', 'class="nodot"')}</div>
      <div class="hint" style="margin:4px 0 12px">Choose the days and the shift you want to work. Your manager decides; once approved, your schedule changes for those days only.</div>
      ${F('Request', I('Change of shift', { sel: 1 }), { req: 1 })}
      <div class="grid2" style="row-gap:10px;margin-top:10px">${F('First day', I('18 Oct 2026', { icon: 'LuCalendar' }), { req: 1 })}${F('Last day', I('22 Oct 2026', { icon: 'LuCalendar' }), { req: 1 })}</div>
      <div class="hint" style="margin:8px 0">Your shift on 18 Oct: Evening 14:00–22:00</div>
      <div class="grid2" style="gap:10px">${F('Shift', I('Morning', { sel: 1 }), { req: 1 })}${F('Reason', I('Evening classes this week'), { req: 1 })}</div>
      <div class="row" style="justify-content:flex-end;margin-top:12px;gap:8px">${btn('Cancel', { cls: 'ghost sm' })}${btn('Send request', { cls: 'sm' })}</div></div>`;
  const recalc = `<div class="float card" data-at="b2+0.1" data-anim="up" style="left:930px;top:640px;width:900px;padding:0;overflow:hidden;box-shadow:0 24px 48px -12px rgba(16,24,40,.3)">
      <div style="padding:12px 16px;border-bottom:1px solid #eef0f3;font-weight:700;font-size:14.5px">Attendance · Recalculations</div>
      <table class="tbl tight"><tr><th>Range</th><th>Scope</th><th>Reason</th><th>Status</th><th>Requested by</th></tr>
      <tr><td class="tnum">04 Oct 2026 → 11 Oct 2026</td><td>Muscat HQ · 1 employees</td><td class="muted">shift assignment EMPLOYEE created</td><td>${swap('b2+1.2', chip('Running', 'blue'), `${chip('Completed')}<small style="display:block;color:#667085;font-size:12px;margin-top:2px">8 records updated</small>`)}</td><td>Aisha Al Balushi</td></tr></table></div>`;
  return scene(
    'change',
    side({
      n: 4,
      kicker: 'Change shifts',
      title: 'Shifts change. <em>History stays.</em>',
      points: [
        ['b0+1.0', 'LuCalendarRange', '<b>Effective from</b> and optional last day'],
        ['b1+0.5', 'LuListChecks', '<b>Bulk</b> change for many employees'],
        ['b1+3.8', 'LuSend', 'Employees <b>request</b> a change'],
        ['b2+0.2', 'LuRefreshCw', 'Past days <b>recalculated</b> automatically'],
      ],
    }) +
      shell({
        active: 'shifts',
        url: '/shifts?tab=assignments',
        content: winA,
        overlay: ovA,
        attrs: 'data-out="b1"',
      }) +
      shell({
        active: 'emp',
        url: '/employees',
        content: winB,
        overlay: ovB,
        attrs: 'data-at="b1" data-anim="fade"',
      }) +
      portal +
      recalc +
      floatToast(
        'b0+4.9',
        'b1',
        'Queued successfully',
        'Past dates are being recalculated. · View job',
      ) +
      floatToast('b1+3.6', 'b2', '3 employees updated', '') +
      CURSOR(
        'b0+0.4:860,700|b0+0.8:#c-assign|b0+2.1:#c-from|b0+4.6:#c-save|b1+0.3:#c-cb0|b1+0.6:#c-cb1|b1+0.9:#c-cb2|b1+1.5:#c-bulk|b1+2.3:#c-menu-shift|b1+3.3:#c-apply',
        'b0+0.8|b0+4.6|b1+0.3|b1+0.6|b1+0.9|b1+1.5|b1+2.3|b1+3.3',
        'b1+3.7',
      ),
  );
};

// ---------------------------------------------------------------- 5. Branch deployments
// /deployments (Enterprise module advanced_scheduling). Enrolment pushes ID, name and card to the host terminals on the first
// day; biometric templates are never sent from the cloud; removal follows the last day. Attendance, calendar and payroll stay
// with the home branch.
export const deploy = () => {
  const person = (n, num, c) =>
    `<div class="who">${av(n, c)}<div><b style="font-weight:600;color:#101828">${n}</b><small class="mono">${num}</small></div></div>`;
  const route = (a, b) =>
    `<span class="row" style="gap:6px"><span class="muted">${a}</span>${ic('LuArrowRight', 'width="14" height="14" style="color:#98a2b3"')}<b style="color:#101828">${b}</b></span>`;
  const content = `
    <div class="ph"><div><h2>Branch deployments</h2><p style="max-width:600px">Employees working at another branch for a while. They can check in at that branch and are on its terminals for those days; their attendance and payroll stay with their own branch.</p></div>${btn('Deploy employee', { icon: 'LuPlus', id: 'dp-add' })}</div>
    <div class="row" style="margin-bottom:12px"><div class="inp sel" style="width:170px;height:36px"><span>All statuses</span></div><div class="inp sel" style="width:150px;height:36px"><span class="ph-t">Branch</span></div></div>
    <div class="card"><table class="tbl"><tr><th>Employee</th><th>From → to</th><th>Period</th><th>Status</th><th>Terminals</th></tr>
      <tr><td>${person('Noor Al Siyabi', 'E-1038', 5)}</td><td>${route('Salalah', 'Muscat HQ')}</td><td class="tnum">01 Oct 2026 → 14 Oct 2026</td><td>${chip('Active', 'green', 'class="nodot"')}</td><td><span class="link">Enrolment job</span></td></tr>
      <tr><td>${person('Hamed Al Busaidi', 'E-1044', 6)}</td><td>${route('Sohar', 'Sur')}</td><td class="tnum">20 Sep 2026 → 30 Sep 2026</td><td>${chip('Ended', 'gray', 'class="nodot"')}</td><td><span class="link">Removal job</span></td></tr>
      <tr id="dp-row" data-at="b2+0.2" data-hl="b2+0.3~b2+3" style="background:#f6fdf9"><td>${person('Salim Al Harthy', 'E-1023', 2)}</td><td>${route('Muscat HQ', 'Sohar')}</td><td class="tnum">11 Oct 2026 → 22 Oct 2026</td><td>${chip('Active', 'green', 'class="nodot"')}</td><td><span class="link">Enrolment job</span></td></tr>
    </table></div>`;
  const story = `<div class="float card" data-at="b0+0.2" data-out="b1+0.4" data-anim="zoom" style="left:960px;top:470px;width:820px;padding:26px 28px;box-shadow:0 30px 60px -12px rgba(16,24,40,.35)">
      <div class="row" style="gap:16px">${av('Salim Al Harthy', 2, 'width:64px;height:64px;font-size:22px')}<div><b style="font-size:24px;letter-spacing:-.01em">Salim Al Harthy</b><div class="hint" style="font-size:15px">Warehouse supervisor · General 08:00 – 17:00</div></div><span style="margin-left:auto">${chip('Home branch: Muscat HQ', 'teal', 'class="nodot" style="height:32px;font-size:14px"')}</span></div>
      <div class="row" style="margin-top:26px;gap:0;align-items:center">
        <div class="node" style="flex:none"><span class="ico">${ic('LuBuilding2')}</span><div><b>Muscat HQ</b><small>Home branch</small></div></div>
        <div style="flex:1;position:relative;height:40px;margin:0 14px"><div style="position:absolute;left:0;right:0;top:19px;border-top:3px dashed #78cfaf"></div><div data-at="b0+1.6" data-anim="left" data-d="1.4" style="position:absolute;left:36%;top:4px;background:#0f6e56;color:#fff;font-size:13.5px;font-weight:650;padding:6px 12px;border-radius:99px">2 weeks · 11 – 22 Oct</div></div>
        <div class="node" style="flex:none;border-color:#1f9873;box-shadow:0 0 0 3px rgba(31,152,115,.15)" data-at="b0+2.4" data-anim="pop"><span class="ico">${ic('LuBuilding2')}</span><div><b>Sohar</b><small>Covering branch</small></div></div>
      </div></div>`;
  const ov = modal(
    'b1+0.9',
    'b2',
    'left:110px;top:40px;width:720px',
    `
    ${mhead('Deploy employee', "The employee keeps their branch, calendar and payroll. A permanent move is a transfer on the employee's profile.")}
    <div class="grid2" style="row-gap:12px">
      ${F('Employee', I('Salim Al Harthy', { sel: 1 }), { req: 1 })}${F('Deploy to branch', I('Sohar', { sel: 1, id: 'dp-branch' }), { req: 1, hint: "Not the employee's own branch.", hl: 'b1+2.6~b1+3.6' })}
      ${F('First day', I('11 Oct 2026', { icon: 'LuCalendar' }), { req: 1, hl: 'b1+3.6~b1+4.5' })}${F('Last day', I('22 Oct 2026', { icon: 'LuCalendar' }), { req: 1, hint: 'At most a year after the first day.', hl: 'b1+3.9~b1+4.8' })}
    </div>
    <div style="margin-top:12px">${F('Reason', I('Cover for the inventory count', { type: 'b1+2.0', cps: 30 }), { req: 1 })}</div>
    <div id="dp-toggle" data-hl="b1+5.2~b2" style="margin-top:14px;border:1px solid var(--border);border-radius:12px;padding:12px 14px;display:flex;gap:12px;align-items:flex-start">${cb('0')}<div><b style="font-size:14.5px">Add to the branch's terminals</b><div class="hint" style="margin-top:3px">Added to the branch's terminals on the first day (at once if that is today) and removed after the last day. A night shift that starts on the last day can still check out there the next morning.</div></div></div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Deploy', { id: 'dp-save' })}</div>`,
  );
  const node = (at, icon, title, sub, danger) =>
    `<div class="node" style="flex:1;align-items:flex-start" data-at="${at}" data-anim="left"><span class="ico" ${danger ? 'style="background:#fef3f2;color:#b42318"' : ''}>${ic(icon)}</span><div><b>${title}</b><small>${sub}</small></div></div>`;
  const flow = `<div class="float card" data-at="b2+0.8" data-out="b3+0.2" style="left:930px;top:600px;width:900px;padding:18px 20px;box-shadow:0 24px 48px -12px rgba(16,24,40,.3)">
      <div class="row" style="justify-content:space-between;margin-bottom:12px"><b style="font-size:16px">What happens on the terminals</b><span class="hint">Biometric templates are never sent from the cloud.</span></div>
      <div class="row" style="gap:10px;align-items:stretch">
        ${node('b2+1.0', 'LuUserPlus', 'Sun 11 Oct · Added', 'SOH-01 Sohar gate: ID, name and card')}
        <span class="arrow" style="align-self:center">${ic('LuChevronRight')}</span>
        ${node('b2+6.4', 'LuFingerprint', 'Card works at once', 'A fingerprint is enrolled once on the terminal')}
        <span class="arrow" style="align-self:center">${ic('LuChevronRight')}</span>
        ${node('b2+3.8', 'LuUserMinus', 'After 22 Oct · Removed', 'Taken off the Sohar terminals automatically', true)}
      </div></div>`;
  const record = `<div class="float card" data-at="b3+0.2" data-anim="up" style="left:930px;top:570px;width:900px;padding:18px 20px;box-shadow:0 24px 48px -12px rgba(16,24,40,.3)">
      <div class="row" style="justify-content:space-between"><div class="row">${av('Salim Al Harthy', 2)}<div><b style="font-size:16px">Salim Al Harthy · Sun 11 Oct</b><div class="hint">Daily attendance</div></div></div>${chip('Present')}</div>
      <div class="grid3" style="grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px">
        ${[
          ['In', '07:56', 'SOH-01 Sohar gate · card'],
          ['Out', '17:04', 'SOH-01 Sohar gate · card'],
          ['Shift', 'General', '08:00 – 17:00'],
          ['Worked', '8 h 08 m', '1 h break deducted'],
        ]
          .map(
            ([l, v, s]) =>
              `<div style="background:#f9fafb;border-radius:10px;padding:10px 12px"><div class="hint">${l}</div><b class="tnum" style="font-size:20px">${v}</b><div class="hint" style="font-size:12px">${s}</div></div>`,
          )
          .join('')}
      </div>
      <div class="row" style="margin-top:14px;gap:8px">${[
        ['Shift: home branch', 'b3+0.7'],
        ['Holidays: Muscat HQ calendar', 'b3+1.3'],
        ['Payroll: Muscat HQ', 'b3+1.9'],
      ]
        .map(([t, a]) => `<span data-at="${a}" data-anim="pop">${chip(t, 'teal')}</span>`)
        .join('')}</div></div>`;
  return scene(
    'deploy',
    side({
      n: 5,
      kicker: 'Working at another branch',
      title: 'Cover another <em>branch</em> for a while',
      points: [
        ['b0+0.6', 'LuArrowRightLeft', '<b>Branch deployment</b> with first and last day'],
        ['b2+0.5', 'LuUserPlus', 'Added to the <b>host terminals</b> on day one'],
        ['b2+3.8', 'LuUserMinus', '<b>Removed automatically</b> after the last day'],
        ['b3+0.5', 'LuShieldCheck', 'Shift, holidays and payroll <b>stay at home</b>'],
      ],
    }) +
      shell({ active: 'dep', url: '/deployments', content, overlay: ov }) +
      story +
      flow +
      record +
      floatToast(
        'b2+0.1',
        'b2+3.0',
        'Queued successfully',
        'Adding the employee to the terminals of Sohar. · View job',
        'top:110px;bottom:auto',
      ) +
      CURSOR(
        'b1+0.2:900,780|b1+0.8:#dp-add|b1+2.7:#dp-branch|b1+5.4:#dp-toggle ~ 26 ~ 24|b1+7.0:#dp-save',
        'b1+0.8|b1+7.0',
        'b2+0.6',
      ),
  );
};

// ---------------------------------------------------------------- 6. Leave
// /leave (module leave): Leave types tab (Paid leave / Allowance / Policy chips), portal "Apply for leave" with its balance
// preview, the Team calendar (bars only, pending dashed) and the daily status "Leave" (never "Absent").
export const leave = () => {
  const types = [
    [
      'AL',
      'Annual Leave',
      '#175cd3',
      true,
      '30 days / year',
      ['Earned monthly', 'Carries 10 days', '7 days notice'],
    ],
    ['CL', 'Casual Leave', '#0e7490', true, '6 days / year', []],
    ['EL', 'Emergency Leave', '#b42318', true, '6 days / year', []],
    ['ML', 'Maternity Leave', '#c11574', true, '98 days / year', ['Women only', 'Special']],
    ['NP', 'No Pay Leave', '#475467', false, 'Not tracked', []],
    ['SL', 'Sick Leave', '#b54708', true, 'Not tracked', []],
  ];
  const winA = `
    <div class="ph"><div><h2>Leave</h2><p>Requests, balances and allocations. Leave feeds the attendance engine: days on leave are never marked absent.</p></div></div>
    <div class="tabs"><span>Requests</span><span data-cls="b2:on">Team calendar</span><span>Balances</span><span>Allocations</span><span data-cls="0~b2:on">Leave types</span></div>
    <div style="position:relative">
    <div data-out="b2">
      <div class="row" style="justify-content:space-between;margin-bottom:10px"><span class="hint">Leave types are referenced by leave records and payroll summaries.</span>${btn('Add leave type', { cls: 'sm', icon: 'LuPlus' })}</div>
      <div class="card"><table class="tbl tight"><tr><th>Code</th><th>Name</th><th>Paid leave</th><th data-hl="b0+4.2~b0+5.3">Allowance</th><th data-hl="b0+5.3~b1">Policy</th><th>Status</th></tr>
      ${types.map(([c, n, col, paid, allow, pol], k) => `<tr data-at="b0+${(0.6 + k * 0.35).toFixed(2)}"><td><span class="row" style="gap:8px"><i style="width:10px;height:10px;border-radius:50%;background:${col};display:inline-block"></i><span class="mono" style="font-weight:600">${c}</span></span></td><td class="strong">${n}</td><td>${paid ? chip('Paid', 'green', 'class="nodot"') : `<span class="pill-s">Unpaid</span>`}</td><td class="${allow === 'Not tracked' ? 'muted' : 'tnum'}">${allow}</td><td>${pol.length ? pol.map((p) => `<span class="pill-s">${p}</span>`).join(' ') : '—'}</td><td>${chip('Active')}</td></tr>`).join('')}</table></div>
    </div>
    <div class="card" data-at="b2+0.1" data-anim="fade" style="position:absolute;left:0;right:0;top:0;padding:0;overflow:hidden">
      <div class="row" style="justify-content:space-between;padding:10px 14px;border-bottom:1px solid #eef0f3"><div class="row" style="gap:6px">${ic('LuChevronLeft', 'width="16" height="16"')}<b style="font-size:15px">October 2026</b>${ic('LuChevronRight', 'width="16" height="16"')}<span class="row" style="gap:6px;margin-left:12px;font-size:13px;color:#344054">${sw()} Show pending</span></div><div class="legend">${[
        ['#175cd3', 'Annual Leave'],
        ['#0e7490', 'Casual Leave'],
        ['#b42318', 'Emergency Leave'],
        ['#b54708', 'Sick Leave'],
      ]
        .map(([c, n]) => `<span><i style="background:${c}"></i>${n}</span>`)
        .join('')}</div></div>
      ${calendar()}</div>
    </div>`;
  const phone = `<div class="float" data-at="b1+0.1" data-out="b2+0.2" data-anim="left" style="left:1440px;top:220px"><div class="phone" style="height:700px"><div class="scr"><div class="notch"></div>
      <div class="ptop">${LOGO}My leave</div>
      <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
        <b style="font-size:17px">Apply for leave</b>
        ${F('Leave type', I('Annual Leave · 18.5 of 30 days left', { sel: 1 }), { req: 1, hl: 'b1+1.2~b2' })}
        <div class="grid2" style="gap:8px">${F('From', I('18 Oct'), { req: 1 })}${F('To', I('20 Oct'), { req: 1 })}</div>
        <div class="row" style="justify-content:space-between;border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:13px"><span>Half day</span>${sw(false)}</div>
        ${F('Reason', I('Family visit'), { req: 1 })}
        <div class="bal" style="display:block;font-size:13px;color:#0e4e3f" data-hl="b1+1.6~b2">This request uses 3 working days.<br><b style="font-size:13.5px">15.5 days of Annual Leave left after this request.</b></div>
        ${btn('Send request', { attrs: 'style="justify-content:center"' })}
      </div></div></div></div>`;
  const status = `<div class="float card" data-at="b2+2.4" data-anim="up" style="left:1150px;top:800px;width:660px;padding:14px 18px;box-shadow:0 24px 48px -12px rgba(16,24,40,.3)">
      <div class="row" style="justify-content:space-between"><div class="row">${av('Khalid Al Amri', 3)}<div><b style="font-size:15px">Khalid Al Amri · Sun 11 Oct</b><div class="hint">Daily attendance · Sick Leave approved</div></div></div>
      <div class="row" style="gap:8px"><span style="text-decoration:line-through;opacity:.5">${chip('Absent', 'red')}</span>${ic('LuArrowRight', 'width="18" height="18" style="color:#98a2b3"')}<span data-at="b2+3.0" data-anim="pop">${chip('Leave', 'blue')}</span></div></div></div>`;
  return scene(
    'leave',
    side({
      n: 6,
      kicker: 'Leave management',
      title: 'Leave, balances <em>&amp; calendar</em>',
      points: [
        ['b0+0.8', 'LuTreePalm', 'Annual, sick, emergency, <b>maternity</b>…'],
        [
          'b0+4.4',
          'LuChartNoAxesColumnIncreasing',
          'Yearly days, <b>monthly accrual,</b> carry forward',
        ],
        ['b1+0.3', 'LuSmartphone', 'Employees apply and <b>see their balance</b>'],
        ['b2+0.4', 'LuCalendarDays', 'Team calendar; <b>leave, never absent</b>'],
      ],
    }) +
      shell({ active: 'leave', url: '/leave', content: winA }) +
      phone +
      status,
  );
};

function calendar() {
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const off = (d) => [5, 6].includes(new Date(Date.UTC(2026, 9, d)).getUTCDay()); // Fri, Sat
  const people = [
    ['Maryam Al Kindi', 'E-1042', [[18, 20, '#175cd3', true, 'b2+0.8']]],
    ['Khalid Al Amri', 'E-1017', [[11, 11, '#b54708', true, 'b2+1.1']]],
    ['Noor Al Siyabi', 'E-1038', [[12, 12, '#b42318', true, 'b2+1.4']]],
    ['Yousuf Al Hinai', 'E-1031', [[21, 22, '#0e7490', false, 'b2+1.7']]],
    ['Hamed Al Busaidi', 'E-1044', [[25, 29, '#175cd3', true, 'b2+2.0']]],
  ];
  const cols = `grid-template-columns:150px repeat(31,1fr) 44px`;
  let html = `<div class="cal" style="${cols}"><div class="nm hd" style="align-items:flex-start;justify-content:center">Employee</div>${days.map((d) => `<div class="hd ${off(d) ? 'we' : ''}" style="${d === 11 ? 'color:#0f6e56;font-weight:800' : ''}">${String(d).padStart(2, '0')}</div>`).join('')}<div class="hd">Days</div>`;
  for (const [n, num, lv] of people) {
    html += `<div class="nm" style="flex-direction:column;align-items:flex-start;justify-content:center;line-height:1.2">${n}<small class="mono" style="font-size:11px;color:#98a2b3;font-weight:450">${num}</small></div>`;
    let total = 0;
    for (const d of days) {
      const L = lv.find((l) => d >= l[0] && d <= l[1]);
      if (L) total += 1;
      html += `<div class="${off(d) ? 'we' : ''}" style="padding:0 1px">${L ? `<span data-at="${L[4]}" data-anim="fade" style="display:block;width:100%;height:24px;border-radius:4px;background:${L[2]};${L[3] ? '' : 'opacity:.6;border:1px dashed rgba(16,24,40,.4)'}"></span>` : ''}</div>`;
    }
    html += `<div class="tnum" style="font-weight:600;color:#344054">${total}</div>`;
  }
  return html + '</div>';
}
