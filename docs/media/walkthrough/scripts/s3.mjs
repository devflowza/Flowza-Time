import { ic, LOGO, CURSOR, shell, side, ORG } from './kit.mjs';
import {
  av,
  who,
  chip,
  tag,
  swap,
  F,
  I,
  btn,
  sw,
  cb,
  toast,
  modal,
  mhead,
  scene,
  spark,
} from './h.mjs';

const FATMA = ['Fatma Al Rawahi', 'FR', '#7a5af8'];

// ---------------------------------------------------------------- 7. Line-manager approvals
export const approvals = () => {
  const reqs = [
    [
      'Leave',
      'blue',
      'Maryam Al Kindi',
      'Annual leave · Sun 18 – Tue 20 Oct · 3 days',
      'Level 1 of 2',
      4,
    ],
    [
      'Attendance correction',
      'amber',
      'Khalid Al Amri',
      'Edit punch · Thu 08 Oct · 17:02',
      'Level 1 of 1',
      3,
    ],
    [
      'Regularisation',
      'violet',
      'Yousuf Al Hinai',
      'I missed a punch · Thu 08 Oct',
      'Level 1 of 1',
      2,
    ],
    ['Shift change', 'teal', 'Noor Al Siyabi', 'Change of shift · 18 – 22 Oct', 'Level 1 of 1', 5],
    [
      'Shift swap',
      'gray',
      'Khalid Al Amri ⇄ Yousuf Al Hinai',
      'Thu 15 Oct · Morning ⇄ Evening',
      'Level 1 of 1',
      3,
    ],
  ];
  const actions = (k) =>
    `<div class="row" style="gap:6px">${btn('Approve', { cls: 'sm', id: `a-ap${k}` })}${btn('Reject', { cls: 'ghost sm' })}<span class="mx" id="a-more${k}" style="display:grid;place-items:center">${ic('LuEllipsis')}</span></div>`;
  const decided = { 0: 'b2+0.6', 1: 'b2+4.5', 2: 'b2+4.5' };
  const content = `
    <div class="ph"><div><h2>Approvals</h2><p>Requests waiting for your decision.</p></div><div class="row">${btn('Delegations', { cls: 'ghost', icon: 'LuUserCheck' })}${btn('Workflows', { cls: 'ghost', icon: 'LuWorkflow', id: 'a-wf' })}</div></div>
    <div class="row" style="justify-content:space-between;margin-bottom:14px"><span class="seg"><span class="on">Pending</span><span>History</span><span>My requests</span></span><span class="seg"><span>Mine</span><span class="on">My team</span><span>Everyone</span></span></div>
    <div style="position:relative;height:50px;margin-bottom:6px"><div class="row card" data-at="b2+3.4" data-out="b2+4.7" style="position:absolute;inset:0;padding:8px 14px;background:#0e2b25;color:#fff;border:0;justify-content:space-between"><b style="font-size:15px">2 selected</b>${btn('Approve selected', { cls: 'sm', id: 'a-bulk', icon: 'LuCheckCheck' })}</div></div>
    <div class="card"><table class="tbl"><tr><th style="width:40px">${cb()}</th><th>Request</th><th>Level</th><th style="width:250px">Decision</th></tr>
      ${reqs
        .map(
          (
            [type, c, name, detail, level, col],
            k,
          ) => `<tr data-at="b1+${(0.3 + k * 0.45).toFixed(2)}"><td>${cb(k === 1 ? 'b2+3.0' : k === 2 ? 'b2+3.3' : null, `a-cb${k}`)}</td>
        <td><div class="row" style="gap:12px">${av(name.split(' ⇄ ')[0], col)}<div><div class="row" style="gap:8px"><b style="font-size:14.5px;color:#101828">${name}</b>${chip(type, c, 'class="nodot" style="height:22px;font-size:12px"')}</div><small style="font-size:13px;color:#667085">${detail}</small></div></div></td>
        <td class="muted" style="font-size:13.5px">${level}</td><td>${decided[k] ? swap(decided[k], actions(k), chip('Approved')) : k === 3 ? swap('b2+3.0', actions(k), chip('Info requested', 'amber')) : actions(k)}</td></tr>`,
        )
        .join('')}</table></div>`;
  const menu = `<div class="float menu" data-at="b2+1.3" data-out="b2+3.0" style="right:96px;top:668px"><div>${ic('LuShieldCheck')}Approve as exception</div><div data-cls="b2+1.6~b2+3:act" id="a-ask">${ic('LuMessageCircleQuestion')}Ask for information</div><div data-cls="b2+2.3~b2+3:act">${ic('LuUserCog')}Reassign</div></div>`;
  const line = `<div class="float card" data-at="b0+0.4" data-out="b1+0.3" data-anim="zoom" style="left:960px;top:360px;width:820px;padding:24px 26px;box-shadow:0 30px 60px -12px rgba(16,24,40,.35)">
      <b style="font-size:18px">Reporting line</b><div class="hint" style="margin:2px 0 18px">Set on each employee's profile, under Employment.</div>
      <div class="row" style="gap:0;align-items:center">
        <div class="node" style="flex:none">${av('Maryam Al Kindi', 4)}<div><b>Maryam Al Kindi</b><small>Accountant · Finance</small></div></div>
        <div style="width:90px;position:relative;height:120px"><svg viewBox="0 0 90 120" style="position:absolute;inset:0;width:90px;height:120px"><path d="M0 60 C45 60 45 20 90 20" stroke="#1f9873" stroke-width="3" fill="none"/><path d="M0 60 C45 60 45 100 90 100" stroke="#98a2b3" stroke-width="2.5" stroke-dasharray="6 5" fill="none"/></svg></div>
        <div style="display:flex;flex-direction:column;gap:20px">
          <div class="node" data-at="b0+2.2" data-anim="left" style="border-color:#1f9873;box-shadow:0 0 0 3px rgba(31,152,115,.15)">${av('Fatma Al Rawahi', 1)}<div><b>Fatma Al Rawahi</b><small>Manager · approves first</small></div></div>
          <div class="node" data-at="b0+4.4" data-anim="left" style="border-style:dashed">${av('Hamed Al Busaidi', 6)}<div><b>Hamed Al Busaidi</b><small>Secondary manager · backup</small></div></div>
        </div></div></div>`;
  const email = `<div class="float email" data-at="b2+4.9" data-out="b3" data-anim="up" style="left:1390px;top:610px"><div class="eh">${ic('LuMail', 'width="16" height="16"')}<span><b style="color:#101828">FlowZa Time</b> · to Fatma Al Rawahi</span></div>
      <div class="eb"><b style="font-size:15px;color:#101828">Shift change request from Noor Al Siyabi</b><div style="margin:6px 0 14px">Change of shift · 18 – 22 Oct · Morning</div><div class="row">${btn('Approve', { cls: 'sm' })}${btn('Reject', { cls: 'ghost sm' })}</div><div class="hint" style="margin-top:10px">One-click decision link</div></div></div>`;
  const wf = modal(
    'b3',
    'end+1',
    'left:70px;top:60px;width:800px',
    `
    ${mhead('Leave approval workflow', 'Request type: Leave · Up to 5 levels')}
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="lvl" data-at="b3+0.4"><span class="n">1</span><div style="flex:1"><b style="font-size:15.5px">Manager</b><div class="hint">Decision: Any one</div></div>${chip("Escalate after 24 h → The next level's approvers", 'amber', 'class="nodot"')}</div>
      <div class="lvl" data-at="b3+1.0"><span class="n">2</span><div style="flex:1"><b style="font-size:15.5px">HR admins</b><div class="hint">Decision: Any one</div></div>${chip('Escalate after 48 h → The owner', 'amber', 'class="nodot"')}</div>
      <div class="lvl" data-at="b3+1.6" style="border-style:dashed;color:#667085;justify-content:center">${ic('LuPlus', 'width="18" height="18"')} Add level <span class="hint">· 2 of 5 used</span></div>
    </div>
    <div class="row" style="gap:10px;margin-top:16px" data-at="b3+2.2"><span class="hint">Only for:</span>${chip('All branches', 'gray', 'class="nodot"')}${chip('Finance', 'gray', 'class="nodot"')}${chip('Warehouse', 'gray', 'class="nodot"')}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Save workflow')}</div>`,
  );
  return scene(
    'approvals',
    side({
      n: 7,
      kicker: 'Line manager approvals',
      title: 'One inbox for <em>every request</em>',
      points: [
        ['b0+1.6', 'LuUserRound', '<b>Line manager</b> plus secondary manager'],
        ['b1+0.4', 'LuInbox', 'Leave, corrections, regularisations, <b>shifts &amp; swaps</b>'],
        ['b2+0.3', 'LuCheckCheck', 'Approve, reject, ask, reassign; <b>bulk or email</b>'],
        ['b3+0.3', 'LuWorkflow', 'Up to <b>5 levels</b> with escalation'],
      ],
    }) +
      shell({ active: 'appr', url: '/approvals', content, overlay: wf, badge: 5, user: FATMA }) +
      menu +
      line +
      email +
      CURSOR(
        'b2-0.4:1500,820|b2+0.4:#a-ap0|b2+1.2:#a-more3|b2+1.8:#a-ask|b2+3.0:#a-cb1|b2+3.3:#a-cb2|b2+4.3:#a-bulk|b2+5.6:#a-wf',
        'b2+0.4|b2+1.2|b2+3.0|b2+3.3|b2+4.3|b2+5.6',
        'b3+0.2',
      ),
  );
};

// ---------------------------------------------------------------- 8. Shift swap
export const swapScene = () => {
  const days = [
    ['Sun', '11', 'm'],
    ['Mon', '12', 'm'],
    ['Tue', '13', 'm'],
    ['Wed', '14', 'm'],
    ['Thu', '15', 'm'],
    ['Fri', '16', 'off'],
    ['Sat', '17', 'off'],
  ];
  const M = `<div class="sh sh-m">Morning<small>06:00 – 14:00</small></div>`,
    E = `<div class="sh sh-e">Evening<small>14:00 – 22:00</small></div>`,
    OFF = `<div class="sh sh-off">Weekly off</div>`;
  const content = `
    <div class="ph"><div><h2>My shift</h2><p>Your schedule for this week.</p></div><div class="row">${btn('Request a shift change', { cls: 'ghost', icon: 'LuCalendarClock' })}${btn('Request a swap', { icon: 'LuRepeat', id: 's-swap' })}</div></div>
    <div class="wk">${days.map(([d, n, s]) => `<div class="d" ${n === '15' ? 'id="s-thu" data-hl="b1+2.6~end"' : ''}><div class="dn">${d}</div><div class="dd">${n}</div>${s === 'off' ? OFF : n === '15' ? `<div style="display:grid">${swap('b1+2.6', M, E).replace('class="stack"', 'class="stack" style="display:grid"')}</div>` : M}</div>`).join('')}</div>
    <div class="card" style="margin-top:18px"><div style="padding:14px 16px;border-bottom:1px solid #eef0f3;font-weight:650">My requests · Swaps</div>
      <table class="tbl"><tr><th>Day</th><th>Colleague</th><th>Shifts</th><th>Decided by</th><th>Status</th></tr>
      <tr data-at="b1+0.2" style="background:#fcfcfd"><td class="strong">Thu 15 Oct</td><td>${who('Yousuf Al Hinai', 'Forklift operator', 2)}</td><td>Morning ⇄ Evening</td><td>${swap('b1+1.8', '<span class="muted">Line manager</span>', 'Fatma Al Rawahi')}</td><td>${swap('b1+1.8', chip('Pending', 'amber'), chip('Approved'))}</td></tr>
      <tr><td class="strong">Thu 24 Sep</td><td>${who('Salim Al Harthy', 'Warehouse supervisor', 0)}</td><td>Morning ⇄ General</td><td>Fatma Al Rawahi</td><td>${chip('Approved')}</td></tr></table></div>`;
  const ov = modal(
    'b0+1.2',
    'b1',
    'left:120px;top:70px;width:700px',
    `
    ${mhead('Request a shift swap', 'Pick a day and a colleague: you work their shift and they work yours. Your manager decides; the swap applies to that day only.')}
    <div class="grid2" style="row-gap:14px">${F('Day', I('Thu 15 Oct 2026', { icon: 'LuCalendar', id: 's-day', focus: 'b0+2.0~b0+2.9' }))}${F('Colleague', I('Yousuf Al Hinai', { sel: 1, icon: 'LuUserRound', id: 's-col', focus: 'b0+2.9~b0+3.8' }))}</div>
    <div class="row" data-at="b0+3.2" style="margin-top:16px;padding:14px;border-radius:12px;background:#f9fafb;justify-content:center;gap:18px">
      <div style="text-align:center"><div class="hint">You</div><div class="sh sh-m" style="margin-top:4px">Morning<small>06:00 – 14:00</small></div></div>
      <span style="color:#0f6e56">${ic('LuArrowLeftRight', 'width="26" height="26"')}</span>
      <div style="text-align:center"><div class="hint">Yousuf Al Hinai</div><div class="sh sh-e" style="margin-top:4px">Evening<small>14:00 – 22:00</small></div></div></div>
    <div style="margin-top:14px">${F('Reason', I('Family appointment in the morning', { type: 'b0+3.6', cps: 34 }))}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Send request', { id: 's-send', icon: 'LuSend' })}</div>`,
  );
  return scene(
    'swap',
    side({
      n: 8,
      kicker: 'Shift swap request',
      title: 'Swap a shift <em>with a colleague</em>',
      points: [
        ['b0+1.0', 'LuRepeat', 'Pick the <b>day</b> and the <b>colleague</b>'],
        ['b1+0.3', 'LuUserCheck', 'The <b>line manager</b> decides'],
        ['b1+2.4', 'LuCalendarCheck', 'Both schedules change for <b>that day only</b>'],
      ],
    }) +
      shell({
        active: 'myshift',
        url: '/my/shift',
        content,
        overlay: ov,
        portal: true,
        user: ['Khalid Al Amri', 'KA', '#e04f16'],
      }) +
      toast(
        'b1+1.9',
        null,
        'Fatma Al Rawahi approved your swap',
        'Thu 15 Oct · you work Evening 14:00 – 22:00',
      ).replace('class="toast"', 'class="toast float" style="right:96px;bottom:110px"') +
      CURSOR(
        'b0+0.4:900,800|b0+1.0:#s-swap|b0+2.1:#s-day|b0+3.0:#s-col|b0+4.6:#s-send',
        'b0+1.0|b0+2.1|b0+3.0|b0+4.6',
        'b1+0.4',
      ),
  );
};

// ---------------------------------------------------------------- 9. Settings & dashboard
export const dashboard = () => {
  const groups = [
    'General',
    'Dashboard',
    'Regional',
    'Attendance',
    'Sync',
    'Integrations',
    'Reports',
    'Notifications',
    'Security',
    'Subscription',
    'Leave',
  ];
  const hlA = {
    Regional: 'b0+2.0~b0+3.3',
    Attendance: 'b0+3.3~b0+4.3',
    Sync: 'b0+4.3~b0+4.9',
    Notifications: 'b0+4.9~b0+5.9',
    Security: 'b0+5.9~b0+7.6',
  };
  const snav = (on, hl = {}) =>
    `<div class="snav">${groups.map((g) => `<div class="${g === on ? 'on' : ''}" ${hl[g] ? `data-cls="${hl[g]}:on"` : ''}>${g}</div>`).join('')}</div>`;
  const scard = (title, icon, body, hl, at) =>
    `<div class="card" style="padding:14px 16px" data-at="${at}" data-hl="${hl}"><div class="row" style="margin-bottom:8px"><span class="ico" style="width:32px;height:32px">${ic(icon)}</span><b style="font-size:15.5px">${title}</b></div>${body}</div>`;
  const kv = (k, v) =>
    `<div class="row" style="justify-content:space-between;font-size:13.5px;padding:4px 0;color:#475467"><span>${k}</span><b style="color:#101828;font-weight:600">${v}</b></div>`;
  const winA = `
    <div class="ph"><div><h2>Settings</h2><p>Organisation-wide configuration for ${ORG}.</p></div></div>
    <div style="display:flex;gap:18px">${snav('', hlA)}
      <div class="grid2" style="flex:1;gap:12px">
        ${scard('Regional', 'LuGlobe', kv('Organisation timezone', 'Asia/Muscat') + kv('Weekly off days', 'Fri, Sat') + '<div class="hint">Branches can override this.</div>', hlA.Regional, 'b0+0.4')}
        ${scard('Attendance', 'LuActivity', kv('Rule set', 'Standard') + kv('Grace in', '10 min') + kv('Missing punch', 'Flag for review'), hlA.Attendance, 'b0+0.6')}
        ${scard('Sync', 'LuRefreshCw', `<div class="row" style="justify-content:space-between;font-size:13.5px;color:#475467;padding:4px 0">Push new employees automatically ${sw()}</div>` + kv('Default sync interval', '5 min'), hlA.Sync, 'b0+0.8')}
        ${scard('Notifications', 'LuBell', `<div class="row" style="justify-content:space-between;font-size:13.5px;color:#475467;padding:4px 0">Device offline alerts ${sw()}</div><div class="row" style="justify-content:space-between;font-size:13.5px;color:#475467;padding:4px 0">Approval reminders ${sw()}</div>`, hlA.Notifications, 'b0+1.0')}
        ${scard('Security', 'LuShieldCheck', `<div class="row" style="justify-content:space-between;font-size:13.5px;color:#475467;padding:4px 0">Require two-factor authentication ${sw()}</div>`, hlA.Security, 'b0+1.2')}
        ${scard('Users &amp; roles', 'LuUsers', `<div class="row" style="flex-wrap:wrap;gap:6px">${['Organisation Owner', 'HR Admin', 'Branch Manager', 'Line Manager', 'Employee', 'Auditor'].map((r) => chip(r, 'gray', 'class="nodot" style="height:24px;font-size:12px"')).join('')}</div><div class="hint" style="margin-top:8px">Branch scope: <b style="color:#101828">Sohar, Muscat HQ</b></div>`, 'b0+7.6~b1', 'b0+1.4')}
      </div></div>`;
  const themes = [
    ['FlowZa Green', '#0e2b25', '#137a5d'],
    ['Midnight Indigo', '#161a3f', '#4f46e5'],
    ['Classic Light', '#ffffff', '#2563eb'],
    ['Desert Gold', '#2a1a10', '#d97706'],
    ['Ocean Teal', '#052e36', '#0d9488'],
    ['Graphite', '#18181b', '#52525b'],
    ['Crimson', '#2b0b12', '#e11d48'],
  ];
  const winB = `
    <div class="ph"><div><h2>Settings</h2><p>Organisation-wide configuration for ${ORG}.</p></div></div>
    <div style="display:flex;gap:18px">${snav('Dashboard')}
      <div style="flex:1"><div class="card" style="padding:18px 20px">
        <b style="font-size:17px">Dashboard style</b><div class="hint" style="margin:2px 0 12px">Changes preview live.</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">${themes.map(([n, sb, br], k) => `<div class="thm ${k === 0 ? 'on' : ''}" id="th${k}" data-at="b1+${(0.4 + k * 0.18).toFixed(2)}" data-anim="pop"><div class="pv"><div class="sb" style="background:${sb};${sb === '#ffffff' ? 'border-right:1px solid #e4e7ec' : ''}"></div><div class="ct"><i style="background:${br};width:60%"></i><i style="background:#e4e7ec;width:85%"></i><i style="background:#e4e7ec;width:70%"></i></div></div><div class="nm">${n}</div></div>`).join('')}</div>
        <div style="font-size:13.5px;font-weight:600;color:#344054;margin:16px 0 8px">Layout</div>
        <div class="grid3" style="gap:10px">${[
          ['Overview', 'KPIs, trend, branches and the side rail.'],
          ['Operations', "Devices, sync jobs and today's punches first"],
          ['Executive', 'No side rail'],
        ]
          .map(
            ([n, d], k) =>
              `<div class="lay ${k === 0 ? 'on' : ''}" id="ly${k}" data-hl="b1+${(3.4 + k * 0.8).toFixed(1)}~b1+${(4.2 + k * 0.8).toFixed(1)}"><b>${n}</b><p>${d}</p></div>`,
          )
          .join('')}</div>
        <div class="row" style="gap:22px;margin-top:16px;font-size:13.5px;color:#344054"><span class="row" style="gap:8px">Trend range <span class="seg"><span>7</span><span class="on">14</span><span>30</span></span></span><span class="row" style="gap:8px">${sw()} Personal greeting</span><span class="row" style="gap:8px">${sw()} Quote of the day</span><span class="row" style="gap:8px">${sw()} Highlight card</span></div>
      </div></div></div>`;
  // ---- the dashboard itself (full width)
  const kpis = [
    [
      'Total employees',
      468,
      'LuUsers',
      '+6 vs last week',
      [452, 455, 458, 460, 462, 466, 468],
      '#1f9873',
    ],
    [
      'Present today',
      412,
      'LuUserCheck',
      '+2.1% vs last week',
      [398, 405, 401, 410, 407, 409, 412],
      '#1f9873',
    ],
    ['Absent', 14, 'LuUserX', '−3 vs last week', [19, 17, 18, 16, 15, 17, 14], '#ef4444'],
    ['On leave', 23, 'LuTreePalm', '+4 vs last week', [18, 19, 21, 20, 22, 21, 23], '#3b82f6'],
    ['Late', 19, 'LuClock', '−5 vs last week', [26, 24, 25, 22, 21, 20, 19], '#f59e0b'],
    ['Devices online', 18, 'LuCpu', 'of 20 terminals', [19, 19, 18, 19, 19, 18, 18], '#1f9873'],
  ];
  const C = { on: '#1f9873', late: '#f59e0b', abs: '#ef4444', lv: '#3b82f6' };
  const trend = [
    [381, 21, 16, 20],
    [384, 19, 15, 21],
    [36, 2, 0, 3],
    [30, 1, 0, 2],
    [379, 23, 17, 22],
    [386, 18, 14, 21],
    [383, 20, 16, 22],
    [388, 17, 13, 22],
    [390, 19, 12, 21],
    [34, 1, 0, 3],
    [31, 2, 0, 2],
    [385, 22, 15, 23],
    [389, 20, 13, 22],
    [393, 19, 14, 23],
  ];
  const tdays = ['28', '29', '30', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
  const trendHtml = `<div class="trend">${trend
    .map(
      (v, k) =>
        `<div class="col" data-at="b2+${(4.2 + k * 0.06).toFixed(2)}" data-anim="grow">${[
          ['on', 0],
          ['late', 1],
          ['abs', 2],
          ['lv', 3],
        ]
          .map(([c, i]) => `<i style="height:${(v[i] / 470) * 100}%;background:${C[c]}"></i>`)
          .join('')}</div>`,
    )
    .join('')}</div>
    <div class="row" style="gap:10px;padding:6px 4px 0;font-size:11.5px;color:#667085">${tdays.map((d) => `<span style="flex:1;text-align:center">${d}</span>`).join('')}</div>`;
  const donutSeg = (v, off, color) =>
    `<circle cx="70" cy="70" r="56" fill="none" stroke="${color}" stroke-width="18" stroke-dasharray="${(v / 449) * 351.9 - 2} 351.9" stroke-dashoffset="${-(off / 449) * 351.9}" transform="rotate(-90 70 70)"/>`;
  const donut = `<svg viewBox="0 0 140 140" width="170" height="170">${donutSeg(393, 0, C.on)}${donutSeg(19, 393, C.late)}${donutSeg(14, 412, C.abs)}${donutSeg(23, 426, C.lv)}<text x="70" y="68" text-anchor="middle" font-size="24" font-weight="750" fill="#101828" font-family="Inter">92%</text><text x="70" y="86" text-anchor="middle" font-size="10" fill="#667085" font-family="Inter">attendance rate</text></svg>`;
  const branches = [
    ['Muscat HQ', 94],
    ['Dubai', 92],
    ['Sohar', 91],
    ['Salalah', 89],
    ['Riyadh', 87],
  ];
  const winC = `
    <div class="row" style="justify-content:space-between;margin-bottom:16px"><div><h2 style="font-size:27px;letter-spacing:-.02em">Good morning, Aisha!</h2><p style="font-size:15px;color:#475467;margin-top:2px">Here's what's happening at ${ORG} today.</p></div>
      <div class="row"><span class="seg"><span>${ic('LuChevronLeft', 'width="14" height="14"')}</span><span class="on">Today · Sun 11 Oct</span><span>${ic('LuChevronRight', 'width="14" height="14"')}</span></span>${chip('Live')}</div></div>
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:14px">${kpis.map(([l, v, i, d, sp, c], k) => `<div class="card kpi" data-at="b2+${(0.3 + k * 0.15).toFixed(2)}" data-hl="${['', 'b2+1.9~b2+2.7', 'b2+2.5~b2+3.2', 'b2+3.1~b2+3.9', 'b2+3.8~b2+4.6', ''][k]}"><div class="l">${ic(i)}${l}</div><div class="v tnum" data-count="0,${v}" data-count-at="b2+${(0.3 + k * 0.15).toFixed(2)}">${v}</div><div class="d" style="${l === 'Absent' || l === 'Late' ? '' : ''}">${d}</div>${spark(sp, c)}</div>`).join('')}</div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-top:14px">
      <div class="card" style="padding:16px 18px" data-at="b2+4.0" data-hl="b3+0.1~b3+1.7"><div class="row" style="justify-content:space-between;margin-bottom:12px"><div><b style="font-size:16px">Attendance trend</b><div class="hint">Last 14 days</div></div><div class="legend"><span><i style="background:${C.on}"></i>On time</span><span><i style="background:${C.late}"></i>Late</span><span><i style="background:${C.abs}"></i>Absent</span><span><i style="background:${C.lv}"></i>On leave</span></div></div>${trendHtml}</div>
      <div class="card" style="padding:16px 18px" data-at="b2+4.6"><b style="font-size:16px">Today's attendance</b><div class="row" style="gap:16px;margin-top:10px">${donut}<div style="display:flex;flex-direction:column;gap:9px;font-size:13.5px;color:#344054;flex:1">${[
        ['On time', 393, C.on],
        ['Late', 19, C.late],
        ['Absent', 14, C.abs],
        ['On leave', 23, C.lv],
      ]
        .map(
          ([l, v, c]) =>
            `<div class="row" style="justify-content:space-between"><span class="row" style="gap:8px"><i style="width:10px;height:10px;border-radius:3px;background:${c};display:inline-block"></i>${l}</span><b class="tnum">${v}</b></div>`,
        )
        .join('')}</div></div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-top:14px">
      <div class="card" style="padding:16px 18px" data-at="b3+1.0" data-hl="b3+1.7~b3+2.8"><b style="font-size:16px">Attendance by branch</b><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">${branches.map(([b, v]) => `<div class="row" style="gap:10px;font-size:13.5px"><span style="width:84px;color:#344054">${b}</span><div class="btrack"><div class="bbar" data-bar="${v}" data-bar-at="b3+1.2"></div></div><b class="tnum" style="width:38px;text-align:right">${v}%</b></div>`).join('')}</div></div>
      <div class="card" style="padding:16px 18px" data-at="b3+1.4" data-hl="b3+2.8~b3+3.9"><div class="row" style="justify-content:space-between"><b style="font-size:16px">Device status</b>${btn('Sync now', { cls: 'ghost sm', icon: 'LuRefreshCw' })}</div><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px;font-size:13.5px">${[
        ['MCT-02 Reception', chip('Online')],
        ['SOH-01 Sohar gate', chip('Online')],
        ['RUH-01 Riyadh office', chip('Vendor degraded', 'amber')],
        ['SLL-02 Salalah store', chip('Offline', 'red')],
      ]
        .map(
          ([d, c]) =>
            `<div class="row" style="justify-content:space-between"><span class="mono" style="font-size:13px">${d}</span>${c}</div>`,
        )
        .join('')}</div></div>
      <div class="card" style="padding:16px 18px" data-at="b3+1.8" data-hl="b3+3.9~b3+5.2"><div class="row" style="justify-content:space-between"><b style="font-size:16px">Awaiting your approval</b>${chip('3', 'amber', 'class="nodot"')}</div><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px;font-size:13.5px">${[
        ['Maryam Al Kindi', 'Leave · Level 2 of 2', 4],
        ['Noor Al Siyabi', 'Shift change', 5],
        ['Hamed Al Busaidi', 'Regularisation', 6],
      ]
        .map(
          ([n, d, c]) =>
            `<div class="row" style="gap:10px">${av(n, c, 'width:28px;height:28px;font-size:11px')}<div><b style="font-weight:600">${n}</b><div class="hint" style="font-size:12px">${d}</div></div></div>`,
        )
        .join('')}</div></div>
    </div>`;
  const reports = `<div class="float card" data-at="b3+5.4" data-anim="down" style="left:800px;top:96px;padding:10px 16px;box-shadow:0 20px 40px -10px rgba(16,24,40,.35);display:flex;gap:12px;align-items:center;z-index:30"><span class="ico">${ic('LuFileText')}</span><div><b style="font-size:15px">Reports</b><div class="hint">Daily, monthly, late, absence, leave…</div></div>${['PDF', 'Excel', 'CSV'].map((f, k) => `<span data-at="b3+${(5.8 + k * 0.3).toFixed(1)}" data-anim="pop">${chip(f, 'teal', 'class="nodot"')}</span>`).join('')}</div>`;
  return scene(
    'dashboard',
    `<div data-out="b2" data-anim="fade">${side({
      n: 9,
      kicker: 'Configure & dashboard',
      title: 'Configure once, <em>watch it live</em>',
      points: [
        ['b0+2.0', 'LuSettings', 'Regional, attendance, sync, <b>notifications, security</b>'],
        ['b0+7.6', 'LuShieldCheck', '<b>Roles</b> and branch scope'],
        ['b1+0.3', 'LuPalette', '<b>7 styles</b> and 3 layouts'],
      ],
    })}</div>` +
      shell({ active: 'set', url: '/settings/regional', content: winA, attrs: 'data-out="b1"' }) +
      shell({
        active: 'set',
        url: '/settings/dashboard',
        content: winB,
        attrs: 'data-at="b1" data-out="b2" data-anim="fade"',
      }) +
      shell({
        active: 'dash',
        url: '/',
        content: winC,
        cls: 'wide',
        attrs: 'data-at="b2-0.1" data-anim="zoom" data-d="0.7"',
      }) +
      reports +
      CURSOR(
        'b1+1.4:1500,820|b1+2.2:#th1|b1+2.8:#th3|b1+3.5:#ly0|b1+4.3:#ly1|b1+5.1:#ly2|b1+5.8:#ly0',
        'b1+5.8',
        'b2-0.2',
      ),
  );
};

// ---------------------------------------------------------------- Outro
export const outro = () =>
  scene(
    'outro',
    `
  <div style="position:absolute;left:0;right:0;top:250px;display:flex;flex-direction:column;align-items:center;text-align:center">
    <div data-at="0.1" data-anim="pop" data-d="0.8">${LOGO.replace('class="logo"', 'style="width:110px;height:110px;filter:drop-shadow(0 18px 40px rgba(93,211,158,.35))"')}</div>
    <div class="intro-title" data-at="0.4" style="margin-top:24px">FlowZa Time</div>
    <div data-at="b0+1.2" style="font-size:36px;color:#b9d3ca;margin-top:6px;font-weight:500">People on time. Business on track.</div>
    <div data-at="b1" data-anim="pop" style="margin-top:56px"><span class="pill">${ic('LuGlobe', 'width="34" height="34" style="color:#0f6e56"')}flowza.com</span></div>
  </div>
  <div class="row" data-at="b1+0.6" style="position:absolute;left:0;right:0;bottom:90px;justify-content:center;gap:28px;color:#78cfaf">${['LuCpu', 'LuBuilding2', 'LuUsers', 'LuCalendarClock', 'LuArrowRightLeft', 'LuTreePalm', 'LuSquareCheck', 'LuRepeat', 'LuLayoutDashboard'].map((i) => ic(i, 'width="30" height="30"')).join('')}</div>`,
    'dark',
  );
export { swapScene as swap };
