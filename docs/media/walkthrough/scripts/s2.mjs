import { ic, LOGO, CURSOR, shell, side } from './kit.mjs';
import { av, who, chip, tag, swap, F, I, btn, sw, cb, toast, modal, mhead, scene } from './h.mjs';

// ---------------------------------------------------------------- 4. Changing shifts
export const change = () => {
  const rows = [
    ['Organisation', 'All employees', 'General · 08:00 – 17:00', '01 Jan 2026', '—'],
    ['Warehouse', 'Department', 'Night · 22:00 – 06:00', '11 Oct 2026', '—'],
    ['Khalid Al Amri', 'Employee', 'Morning · 06:00 – 14:00', '01 Sep 2026', '—'],
  ];
  const tr = (r, extra = '') =>
    `<tr ${extra}><td class="strong">${r[0]}<small style="display:block;font-weight:450;color:#667085;font-size:12.5px">${r[1]}</small></td><td>${r[2]}</td><td class="tnum">${r[3]}</td><td class="tnum">${r[4]}</td></tr>`;
  const winA = `
    <div class="ph"><div><h2>Shifts &amp; schedules</h2><p>Shifts, rotations and who works when.</p></div>${btn('Assign shift', { icon: 'LuPlus', id: 'c-assign' })}</div>
    <div class="tabs"><span>Shifts</span><span>Patterns</span><span class="on">Assignments</span><span>Rule sets</span><span>Roster</span><span>Shift requests</span></div>
    <div class="card"><table class="tbl"><tr><th>Applies to</th><th>Shift</th><th>Effective from</th><th>Effective to (last day)</th></tr>${rows.map((r) => tr(r)).join('')}
      ${tr(['Khalid Al Amri', 'Employee', 'Evening · 14:00 – 22:00', '04 Oct 2026', '29 Oct 2026'], 'data-at="b0+5.0" data-hl="b0+5.1~b1" style="background:#f6fdf9"')}</table></div>`;
  const ovA = modal(
    'b0+0.9',
    'b0+4.8',
    'left:150px;top:90px;width:640px',
    `
    ${mhead('Assign shift', '')}
    ${F('Assign to', `<span class="seg"><span>Organisation</span><span>Branch</span><span>Department</span><span>Team</span><span class="on">Employee</span></span>`)}
    <div class="grid2" style="margin-top:14px;row-gap:14px">${F('Employee', I('Khalid Al Amri', { sel: 1, icon: 'LuUserRound' }))}${F('Shift', I('Evening · 14:00 – 22:00', { sel: 1 }), { hl: 'b0+1.4~b0+2.2' })}
      ${F('Effective from', I('04 Oct 2026', { type: 'b0+2.2', icon: 'LuCalendar', focus: 'b0+2.1~b0+3.1' }))}${F('Effective to (last day)', I('29 Oct 2026', { type: 'b0+3.4', icon: 'LuCalendar', focus: 'b0+3.3~b0+4.4' }), { hl: 'b0+3.3~b0+4.6' })}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Save', { id: 'c-save' })}</div>`,
  );
  const emps = [
    ['Yousuf Al Hinai', 'E-1031', 'Morning'],
    ['Salim Al Harthy', 'E-1023', 'General'],
    ['Hamed Al Busaidi', 'E-1044', 'General'],
    ['Noor Al Siyabi', 'E-1038', 'General'],
    ['Maryam Al Kindi', 'E-1042', 'General'],
  ];
  const winB = `
    <div class="ph"><div><h2>Employees</h2><p>468 people across 6 branches</p></div>${btn('Add employee', { icon: 'LuPlus' })}</div>
    <div class="row card" data-at="b1+1.0" style="padding:10px 14px;margin-bottom:12px;background:#0e2b25;color:#fff;border:0;justify-content:space-between"><b style="font-size:15px">3 selected</b><div class="row">${btn('Sync to devices', { cls: 'ghost sm' })}${btn('Assign…', { cls: 'sm', id: 'c-bulk', icon: 'LuChevronDown' })}</div></div>
    <div class="card"><table class="tbl"><tr><th style="width:40px">${cb()}</th><th>Employee</th><th>Department</th><th>Current shift</th></tr>
      ${emps.map((e, k) => `<tr><td>${cb(k < 3 ? `b1+${(0.3 + k * 0.3).toFixed(1)}` : null, `c-cb${k}`)}</td><td>${who(e[0], e[1], k + 2)}</td><td>Warehouse</td><td>${k < 3 ? swap('b1+3.2', e[2], `<b style="color:#4a1fb8">Evening</b>`) : e[2]}</td></tr>`).join('')}</table></div>`;
  const ovB = `<div class="float menu" data-at="b1+1.7" data-out="b1+2.6" style="right:28px;top:170px"><div>${ic('LuBuilding2')}Assign branch</div><div>${ic('LuNetwork')}Assign department</div><div class="act" id="c-menu-shift">${ic('LuCalendarClock')}Assign shift (3)</div><div>${ic('LuUserCheck')}Set status</div></div>`;
  const portal = `<div class="float card" data-at="b1+3.6" data-out="b2+0.1" data-anim="left" style="left:1300px;top:470px;width:520px;padding:18px 20px;box-shadow:0 24px 48px -12px rgba(16,24,40,.35)">
      <div class="row" style="justify-content:space-between"><b style="font-size:17px">Request a shift change</b>${chip('Employee portal', 'teal', 'class="nodot"')}</div>
      <div style="margin:12px 0"><span class="seg"><span class="on">Change of shift</span><span>Additional shift</span></span></div>
      <div class="grid2" style="row-gap:12px">${F('First day', I('18 Oct 2026', { icon: 'LuCalendar' }))}${F('Last day', I('22 Oct 2026', { icon: 'LuCalendar' }))}${F('Shift', I('Morning · 06:00 – 14:00', { sel: 1 }))}${F('Reason', I('Evening classes this week'))}</div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">${btn('Send request', { cls: 'sm', icon: 'LuSend' })}</div></div>`;
  const recalc = `<div class="float card" data-at="b2+0.1" data-anim="up" style="left:960px;top:760px;width:560px;padding:16px 18px;box-shadow:0 24px 48px -12px rgba(16,24,40,.3)">
      <div class="row" style="justify-content:space-between;margin-bottom:10px"><b style="font-size:15.5px">Recalculation · Khalid Al Amri</b>${swap('b2+2.0', chip('Running', 'blue'), chip('Success'))}</div>
      <div class="row" style="gap:8px">${['Sun 04', 'Mon 05', 'Tue 06', 'Wed 07', 'Thu 08'].map((d, k) => `<div style="flex:1;border:1px solid var(--border);border-radius:10px;padding:8px;text-align:center;font-size:12.5px;color:#475467" data-cls="b2+${(0.4 + k * 0.32).toFixed(2)}:done"><div style="font-weight:600">${d}</div><div style="margin-top:4px;color:#067647" data-at="b2+${(0.4 + k * 0.32).toFixed(2)}" data-anim="pop">${ic('LuCircleCheck', 'width="18" height="18"')}</div></div>`).join('')}</div></div>`;
  return scene(
    'change',
    side({
      n: 4,
      kicker: 'Change shifts',
      title: 'Shifts change. <em>History stays.</em>',
      points: [
        ['b0+1.0', 'LuCalendarRange', '<b>Effective from</b> and optional last day'],
        ['b1+0.5', 'LuListChecks', '<b>Bulk</b> change for many employees'],
        ['b1+3.6', 'LuSend', 'Employees <b>request</b> a change'],
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
      toast('b2+0.2', null, 'Shift assigned', 'Past dates are being recalculated.').replace(
        'class="toast"',
        'class="toast float" style="right:96px;bottom:110px"',
      ) +
      CURSOR(
        'b0+0.4:860,700|b0+0.8:#c-assign|b0+2.1:.modal .grid2 > div:nth-child(3)|b0+4.6:#c-save|b1+0.3:#c-cb0|b1+0.6:#c-cb1|b1+0.9:#c-cb2|b1+1.6:#c-bulk|b1+2.4:#c-menu-shift',
        'b0+0.8|b0+4.6|b1+0.3|b1+0.6|b1+0.9|b1+1.6|b1+2.4',
        'b1+3.3',
      ),
  );
};

// ---------------------------------------------------------------- 5. Branch deployments
export const deploy = () => {
  const tr = (cells, extra = '') =>
    `<tr ${extra}>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const content = `
    <div class="ph"><div><h2>Branch deployments</h2><p style="max-width:560px">Employees working at another branch for a while. They can check in at that branch and are on its terminals for those days.</p></div>${btn('Deploy employee', { icon: 'LuArrowRightLeft', id: 'dp-add' })}</div>
    <div class="card"><table class="tbl"><tr><th>Employee</th><th>From → to</th><th>Period</th><th>Terminals</th><th>Status</th></tr>
      ${tr([who('Noor Al Siyabi', 'Sales executive', 5), 'Salalah → Muscat HQ', '01 Oct – 14 Oct', chip('Enrolled', 'teal'), chip('Active')])}
      ${tr([who('Hamed Al Busaidi', 'Driver', 6), 'Sohar → Dubai', '20 Sep – 30 Sep', chip('Removed', 'gray'), chip('Ended', 'gray')])}
      ${tr([who('Salim Al Harthy', 'Warehouse supervisor', 2), '<b>Muscat HQ → Sohar</b>', '11 Oct – 22 Oct', swap('b2+1.2', chip('Queued', 'blue'), chip('Enrolled', 'teal')), swap('b2+2.0', chip('Scheduled', 'amber'), chip('Active'))], 'id="dp-row" data-at="b2+0.2" data-hl="b2+0.3~b2+3" style="background:#f6fdf9"')}
    </table></div>`;
  const story = `<div class="float card" data-at="b0+0.2" data-out="b1+0.4" data-anim="zoom" style="left:960px;top:420px;width:820px;padding:26px 28px;box-shadow:0 30px 60px -12px rgba(16,24,40,.35)">
      <div class="row" style="gap:16px">${av('Salim Al Harthy', 2, 'width:64px;height:64px;font-size:22px')}<div><b style="font-size:24px;letter-spacing:-.01em">Salim Al Harthy</b><div class="hint" style="font-size:15px">Warehouse supervisor · General 08:00 – 17:00</div></div><span style="margin-left:auto">${chip('Home branch: Muscat HQ', 'teal', 'class="nodot" style="height:32px;font-size:14px"')}</span></div>
      <div class="row" style="margin-top:26px;gap:0;align-items:center">
        <div class="node" style="flex:none"><span class="ico">${ic('LuBuilding2')}</span><div><b>Muscat HQ</b><small>Home branch</small></div></div>
        <div style="flex:1;position:relative;height:40px;margin:0 14px"><div style="position:absolute;left:0;right:0;top:19px;border-top:3px dashed #78cfaf"></div><div data-at="b0+1.6" data-anim="left" data-d="1.4" style="position:absolute;left:42%;top:4px;background:#0f6e56;color:#fff;font-size:13.5px;font-weight:650;padding:6px 12px;border-radius:99px">2 weeks · 11 – 22 Oct</div></div>
        <div class="node" style="flex:none;border-color:#1f9873;box-shadow:0 0 0 3px rgba(31,152,115,.15)" data-at="b0+2.4" data-anim="pop"><span class="ico">${ic('LuBuilding2')}</span><div><b>Sohar</b><small>Covering branch</small></div></div>
      </div></div>`;
  const ov = modal(
    'b1+0.9',
    'b2',
    'left:110px;top:60px;width:720px',
    `
    ${mhead('Deploy employee', 'Attendance and payroll stay with their own branch.')}
    <div class="grid2" style="row-gap:14px">
      ${F('Employee', I('Salim Al Harthy', { sel: 1, icon: 'LuUserRound' }))}${F('Deploy to branch', I('Sohar', { sel: 1, icon: 'LuBuilding2', id: 'dp-branch' }), { hl: 'b1+2.6~b1+3.6' })}
      ${F('First day', I('Sun 11 Oct 2026', { icon: 'LuCalendar' }), { hl: 'b1+3.6~b1+4.5' })}${F('Last day', I('Thu 22 Oct 2026', { icon: 'LuCalendar' }), { hint: 'At most a year after the first day.', hl: 'b1+3.9~b1+4.8' })}
    </div>
    <div style="margin-top:14px">${F('Reason', I('Cover for inventory count', { type: 'b1+2.0', cps: 30 }))}</div>
    <div id="dp-toggle" data-hl="b1+5.2~b2" style="margin-top:16px;border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;gap:14px;align-items:flex-start">${sw(true)}<div><b style="font-size:15px">Add to the branch's terminals</b><div class="hint" style="margin-top:3px">Added to the branch's terminals on the first day… removed after the last day. A night shift that starts on the last day can still check out there the next morning.</div></div></div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Deploy', { id: 'dp-save', icon: 'LuArrowRightLeft' })}</div>`,
  );
  const flow = `<div class="float card" data-at="b2+0.8" data-out="b3+0.2" style="left:930px;top:600px;width:900px;padding:20px 22px;box-shadow:0 24px 48px -12px rgba(16,24,40,.3)">
      <div class="row" style="justify-content:space-between;margin-bottom:14px"><b style="font-size:16px">What happens on the terminals</b><span class="hint">automatic, no manual sync</span></div>
      <div class="row" style="gap:12px;align-items:stretch">
        <div class="node" style="flex:1" data-at="b2+1.2" data-anim="left"><span class="ico">${ic('LuUserPlus')}</span><div><b>Sun 11 Oct · Enrolled</b><small>Pushed to SOH-01 Sohar gate</small></div></div>
        <span class="arrow" style="align-self:center">${ic('LuChevronRight')}</span>
        <div class="node" style="flex:1" data-at="b2+3.0" data-anim="left"><span class="ico">${ic('LuFingerprint')}</span><div><b>Punches at Sohar</b><small>07:56 in · 17:04 out</small></div></div>
        <span class="arrow" style="align-self:center">${ic('LuChevronRight')}</span>
        <div class="node" style="flex:1" data-at="b2+5.0" data-anim="left"><span class="ico" style="background:#fef3f2;color:#b42318">${ic('LuUserMinus')}</span><div><b>After 22 Oct · Removed</b><small>Taken off Sohar terminals</small></div></div>
      </div></div>`;
  const record = `<div class="float card" data-at="b3+0.2" data-anim="up" style="left:930px;top:570px;width:900px;padding:20px 22px;box-shadow:0 24px 48px -12px rgba(16,24,40,.3)">
      <div class="row" style="justify-content:space-between"><div class="row">${av('Salim Al Harthy', 2)}<div><b style="font-size:16px">Salim Al Harthy · Sun 11 Oct</b><div class="hint">Attendance record</div></div></div>${chip('Present')}</div>
      <div class="grid3" style="grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px">
        ${[
          ['In', '07:56', 'SOH-01 Sohar gate'],
          ['Out', '17:04', 'SOH-01 Sohar gate'],
          ['Shift', 'General', '08:00 – 17:00'],
          ['Worked', '9 h 08 m', 'incl. 1 h break'],
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
        ['No manual fixes', 'b3+3.4'],
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
        ['b2+0.5', 'LuFingerprint', 'Enrolled on the <b>host terminals</b> on day one'],
        ['b2+5.0', 'LuUserMinus', '<b>Removed automatically</b> after the last day'],
        ['b3+0.5', 'LuShieldCheck', 'Shift, holidays and payroll <b>stay at home</b>'],
      ],
    }) +
      shell({ active: 'dep', url: '/deployments', content, overlay: ov }) +
      story +
      flow +
      record +
      CURSOR(
        'b1+0.2:900,780|b1+0.8:#dp-add|b1+2.7:#dp-branch|b1+5.4:#dp-toggle ~ 36 ~ 26|b1+7.0:#dp-save',
        'b1+0.8|b1+7.0',
        'b2+0.6',
      ),
  );
};

// ---------------------------------------------------------------- 6. Leave
export const leave = () => {
  const types = [
    ['AL', 'Annual leave', '30', 'Monthly', '10 days', 'Yes'],
    ['SL', 'Sick leave', '21', 'All at the start of the year', '—', 'Yes'],
    ['CL', 'Casual leave', '6', 'All at the start of the year', '—', 'Yes'],
    ['EL', 'Emergency leave', '6', 'All at the start of the year', '—', 'Yes'],
    ['ML', 'Maternity leave', '98', 'Special leave', '—', 'Yes'],
    ['NP', 'No pay leave', '—', '—', '—', 'No'],
  ];
  const winA = `
    <div class="ph"><div><h2>Leave</h2><p>Requests, balances and the team calendar.</p></div>${btn('Record leave', { icon: 'LuPlus' })}</div>
    <div class="tabs"><span>Requests</span><span data-cls="b2:on">Team calendar</span><span>Balances</span><span>Allocations</span><span data-cls="0~b2:on">Leave types</span></div>
    <div style="position:relative">
    <div class="card" data-out="b2"><table class="tbl"><tr><th>Code</th><th>Leave type</th><th data-hl="b0+4.4~b0+5.4">Days per year</th><th data-hl="b0+5.4~b0+6.4">Earned</th><th data-hl="b0+6.4~b1">Carry forward (days)</th><th>Paid leave</th></tr>
      ${types.map((t, k) => `<tr data-at="b0+${(0.6 + k * 0.35).toFixed(2)}"><td><span class="mono" style="font-weight:600">${t[0]}</span></td><td class="strong">${t[1]}</td><td class="tnum">${t[2]}</td><td>${t[3]}</td><td>${t[4]}</td><td>${t[5] === 'Yes' ? chip('Paid', 'green') : chip('Unpaid', 'gray')}</td></tr>`).join('')}</table></div>
    <div class="grid3" data-out="b2" style="margin-top:16px">${[
      ['LuInbox', 'Pending requests', '4'],
      ['LuTreePalm', 'On leave today', '23'],
      ['LuCalendarDays', 'Upcoming holidays', '2'],
    ]
      .map(
        ([i, l, v], k) =>
          `<div class="card kpi" data-at="b0+${(3.0 + k * 0.3).toFixed(1)}"><div class="l">${ic(i)}${l}</div><div class="v tnum">${v}</div></div>`,
      )
      .join('')}</div>
    <div class="card" data-at="b2+0.1" data-anim="fade" style="position:absolute;left:0;right:0;top:0;padding:0;overflow:hidden">
      <div class="row" style="justify-content:space-between;padding:12px 16px;border-bottom:1px solid #eef0f3"><b style="font-size:15px">October 2026 · Warehouse &amp; Finance</b><div class="legend"><span><i style="background:#3b82f6"></i>Approved leave</span><span><i style="background:#93c5fd"></i>Pending</span></div></div>
      ${calendar()}</div>
    </div>`;
  const phone = `<div class="float" data-at="b1+0.1" data-out="b2+0.2" data-anim="left" style="left:1430px;top:250px"><div class="phone"><div class="scr"><div class="notch"></div>
      <div class="ptop">${LOGO}My leave</div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <b style="font-size:18px">Apply for leave</b>
        ${F('Leave type', I('Annual leave', { sel: 1 }))}
        <div class="grid2" style="gap:10px">${F('From', I('Sun 18 Oct'))}${F('To', I('Tue 20 Oct'))}</div>
        <div class="bal" data-hl="b1+1.6~b2"><div><div class="hint">Available</div><b class="tnum">18.5 days</b></div><div style="text-align:right"><div class="hint">After this request</div><b class="tnum" style="color:#0f6e56">15.5</b></div></div>
        <div class="hint">3 working days · needs approval</div>
        ${btn('Apply for leave', { attrs: 'style="justify-content:center"' })}
      </div></div></div></div>`;
  const absence = `<div class="float card" data-at="b2+2.6" data-anim="up" style="left:1150px;top:770px;width:640px;padding:16px 18px;box-shadow:0 24px 48px -12px rgba(16,24,40,.3)">
      <div class="row" style="justify-content:space-between"><div class="row">${av('Maryam Al Kindi', 4)}<div><b style="font-size:15px">Maryam Al Kindi · Mon 19 Oct</b><div class="hint">Daily attendance</div></div></div>
      <div class="row" style="gap:8px"><span style="text-decoration:line-through;opacity:.55">${chip('Absent', 'red')}</span>${ic('LuArrowRight', 'width="18" height="18" style="color:#98a2b3"')}<span data-at="b2+3.2" data-anim="pop">${chip('On leave', 'blue')}</span></div></div></div>`;
  return scene(
    'leave',
    side({
      n: 6,
      kicker: 'Leave management',
      title: 'Leave, balances <em>&amp; calendar</em>',
      points: [
        ['b0+0.8', 'LuTreePalm', 'Annual, sick, emergency, <b>maternity</b>…'],
        [
          'b0+4.6',
          'LuChartNoAxesColumnIncreasing',
          'Yearly days, <b>monthly accrual,</b> carry forward',
        ],
        ['b1+0.3', 'LuSmartphone', 'Employees apply and <b>see their balance</b>'],
        ['b2+0.4', 'LuCalendarDays', 'Team calendar; <b>leave, not absence</b>'],
      ],
    }) +
      shell({ active: 'leave', url: '/leave', content: winA }) +
      phone +
      absence,
  );
};

function calendar() {
  const days = Array.from({ length: 14 }, (_, i) => 11 + i);
  const dn = (d) => ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'][(d - 1) % 7];
  const people = [
    ['Maryam Al Kindi', [[18, 20, 'AL · Annual', '#3b82f6', 'b2+0.9']]],
    ['Khalid Al Amri', [[14, 14, 'SL', '#3b82f6', 'b2+1.2']]],
    ['Yousuf Al Hinai', [[21, 22, 'CL · pending', '#93c5fd', 'b2+1.5']]],
    ['Fatma Al Rawahi', []],
    ['Salim Al Harthy', [[11, 22, 'Deployed to Sohar', '#d5f2e5', 'b2+1.8', '#0e4e3f']]],
    ['Noor Al Siyabi', [[12, 12, 'EL', '#3b82f6', 'b2+2.1']]],
  ];
  let html = `<div class="cal"><div class="nm hd" style="align-items:flex-start;justify-content:center">Employee</div>${days.map((d) => `<div class="hd ${['Fri', 'Sat'].includes(dn(d)) ? 'we' : ''}"><span style="font-size:11px;color:#98a2b3">${dn(d)}</span>${d}</div>`).join('')}`;
  for (const [n, lv] of people) {
    html += `<div class="nm">${n}</div>`;
    days.forEach((d, i) => {
      const L = lv.find((l) => l[0] === d);
      html += `<div class="${['Fri', 'Sat'].includes(dn(d)) ? 'we' : ''}">${L ? `<span class="lv" data-at="${L[4]}" data-anim="right" style="left:4px;width:calc(${(L[1] - L[0] + 1) * 100}% - 8px);background:${L[3]};${L[5] ? `color:${L[5]}` : ''}">${L[2]}</span>` : ''}</div>`;
    });
  }
  return html + '</div>';
}
