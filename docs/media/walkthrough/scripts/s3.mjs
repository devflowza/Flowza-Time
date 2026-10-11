import { ic, LOGO, CURSOR, shell, side, ORG } from './kit.mjs';
import { av, who, chip, tag, swap, F, I, btn, sw, cb, toast, modal, mhead, scene } from './h.mjs';

const FATMA = ['Fatma Al Rawahi', 'FR', '#7a5af8'];
const floatToast = (at, out, title, sub, extra = '') =>
  toast(at, out, title, sub).replace(
    'class="toast"',
    `class="toast float" style="right:96px;bottom:110px;${extra}"`,
  );

// ---------------------------------------------------------------- 7. Line-manager approvals
// A line manager (system role "Line Manager") sees Mine / My team and Delegations; Approve and Reject open a dialog; "Ask for
// information" lives in the request panel; Reassign / Approve as exception and Workflows are for approval admins (HR).
export const approvals = () => {
  const reqs = [
    [
      'Maryam Al Kindi',
      'E-1042',
      'Leave',
      'LuTreePalm',
      `<b>Annual Leave</b> · 18 Oct → 20 Oct 2026 <span class="pill-s">3 days</span>`,
      'Level 1 of 2',
      'Manager · any one approves',
      4,
    ],
    [
      'Khalid Al Amri',
      'E-1017',
      'Attendance correction',
      'LuClipboardList',
      `08 Oct 2026 <span class="pill-s">Edit punch</span> 17:02 → 18:00`,
      'Level 1 of 1',
      'Role or permission · any one approves',
      3,
    ],
    [
      'Yousuf Al Hinai',
      'E-1031',
      'Regularisation',
      'LuClipboardCheck',
      `08 Oct 2026 <span class="pill-s">Missed punch</span> 08:00 – 17:00`,
      'Level 1 of 1',
      'Manager · any one approves',
      2,
    ],
    [
      'Noor Al Siyabi',
      'E-1038',
      'Shift change',
      'LuCalendarClock',
      `18 Oct → 22 Oct 2026 <span class="pill-s">Change of shift</span> Evening → Morning`,
      'Level 1 of 1',
      'Manager · any one approves',
      5,
    ],
    [
      'Khalid Al Amri',
      'E-1017',
      'Shift swap',
      'LuRepeat',
      `15 Oct 2026 · Khalid Al Amri ⇄ Yousuf Al Hinai · Morning ⇄ Evening`,
      'Level 1 of 1',
      'Manager · any one approves',
      3,
    ],
  ];
  const outAt = { 0: 'b2+1.4', 1: 'b2+4.2', 2: 'b2+4.2' };
  const actions = (k) =>
    `<div class="row" style="gap:6px;justify-content:flex-end">${btn('Reject', { cls: 'ghost sm', icon: 'LuX' })}${btn('Approve', { cls: 'sm', id: `a-ap${k}`, icon: 'LuCheck' })}</div>`;
  const content = `
    <div class="ph"><div><h2>Approvals</h2><p>Requests waiting for your decision — attendance corrections, leave and more — and what was decided.</p></div>${btn('Delegations', { cls: 'ghost sm', icon: 'LuUserCheck' })}</div>
    <div class="row" style="gap:10px;margin-bottom:12px;flex-wrap:wrap"><span class="seg"><span class="on">Pending</span><span>History</span><span>My requests</span></span><span class="seg"><span class="on">Mine</span><span>My team</span></span><span class="seg"><span class="on">All types</span><span>Attendance correction</span><span>Leave</span></span></div>
    <div style="position:relative;height:46px;margin-bottom:6px"><div class="row card" data-at="b2+3.4" data-out="b2+4.3" style="position:absolute;inset:0;padding:6px 12px;background:#eefaf5;border-color:#d5f2e5;justify-content:space-between"><b style="font-size:14.5px;color:#0e4e3f">2 selected</b>${btn('Approve selected', { cls: 'sm', id: 'a-bulk', icon: 'LuCheck' })}</div>
      <div class="inp" data-out="b2+3.4" style="position:absolute;left:0;top:4px;width:320px;height:38px"><span class="ph-t">Search employee name or number</span></div></div>
    <div class="card"><table class="tbl tight"><tr><th style="width:36px">${cb()}</th><th>Request</th><th>Details</th><th>Level</th><th></th></tr>
      ${reqs
        .map(
          (
            [n, num, type, icon, det, lvl, who_, col],
            k,
          ) => `<tr id="a-row${k}" data-at="b1+${(0.3 + k * 0.45).toFixed(2)}" ${outAt[k] ? `data-out="${outAt[k]}" data-anim="collapse"` : 'data-anim="fade"'}><td>${cb(k === 1 ? 'b2+3.0' : k === 2 ? 'b2+3.3' : null, `a-cb${k}`)}</td>
        <td><div class="row" style="gap:10px"><span class="ico" style="width:34px;height:34px">${ic(icon)}</span><div><b style="font-size:14px;color:#101828">${n}</b><small style="display:block;font-size:12.5px;color:#667085">${type} <span class="mono">${num}</span></small></div></div></td>
        <td style="font-size:13px;max-width:250px">${det}</td>
        <td><b style="font-size:13.5px;color:#101828">${lvl}</b><small style="display:block;font-size:12px;color:#667085">${who_}</small>${k === 3 ? `<span data-at="b2+2.7" data-anim="pop">${chip('Waiting for an answer', 'amber', 'style="height:22px;font-size:11.5px;margin-top:4px"')}</span>` : ''}</td>
        <td>${actions(k)}</td></tr>`,
        )
        .join('')}</table></div>`;
  const approveDlg = modal(
    'b2+0.5',
    'b2+1.3',
    'left:190px;top:170px;width:560px',
    `
    ${mhead('Approve request', 'Your approval completes this level; the next level is notified, and after the last level the request takes effect.')}
    <div class="grp"><b style="font-size:14px">Maryam Al Kindi <span class="mono muted">E-1042</span></b><div class="hint">Leave · Level 1 of 2</div><div style="font-size:13px;margin-top:4px">Annual Leave · 18 Oct → 20 Oct 2026</div></div>
    <div style="margin-top:12px">${F('Comment', I('Optional note for the requester', { ph: 1 }), { opt: 1 })}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Approve', { id: 'a-confirm' })}</div>`,
  );
  const panel = `<div class="float card" data-at="b2+1.7" data-out="b2+2.6" data-anim="left" style="right:70px;top:132px;width:440px;height:862px;border-radius:0 18px 18px 0;padding:20px;box-shadow:-20px 0 40px -12px rgba(16,24,40,.3)">
      <h3 style="font-size:19px">Request</h3><div class="grp" style="margin-top:12px"><b>Noor Al Siyabi <span class="mono muted">E-1038</span></b><div class="hint">Shift change · Level 1 of 1</div><div style="font-size:13px;margin-top:4px">18 Oct → 22 Oct 2026 · Change of shift · Evening → Morning</div><div class="hint" style="margin-top:4px">“Evening classes this week”</div></div>
      <div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">${btn('Approve', { cls: 'sm', icon: 'LuCheck' })}${btn('Reject', { cls: 'ghost sm', icon: 'LuX' })}${btn('Ask for information', { cls: 'ghost sm', icon: 'LuCircleHelp', id: 'a-ask' })}</div>
      <div style="margin-top:18px;font-size:13px;font-weight:700;color:#475467">Timeline</div><div class="hint" style="margin-top:6px">Submitted · Noor Al Siyabi</div></div>`;
  const profile = `<div class="float card" data-at="b0+0.4" data-out="b1+0.3" data-anim="zoom" style="left:960px;top:330px;width:820px;padding:22px 24px;box-shadow:0 30px 60px -12px rgba(16,24,40,.35)">
      <div class="row" style="justify-content:space-between"><div class="row">${av('Maryam Al Kindi', 4, 'width:44px;height:44px')}<div><b style="font-size:18px">Maryam Al Kindi</b><div class="hint">Reports to: Fatma Al Rawahi · also Hamed Al Busaidi</div></div></div>${chip('Employee profile · Employment', 'gray', 'class="nodot"')}</div>
      <div class="grid2" style="margin-top:16px;gap:14px">
        <div data-at="b0+2.0" data-anim="up">${F('Manager', I('Fatma Al Rawahi', { sel: 1, icon: 'LuUserRound' }), { opt: 1, hint: "Line manager: sees this employee's attendance and leave as a direct report and approves their requests." })}</div>
        <div data-at="b0+4.2" data-anim="up">${F('Secondary manager', I('Hamed Al Busaidi', { sel: 1, icon: 'LuUserRound' }), { opt: 1, hint: 'Dotted-line manager: also sees this employee as a direct report and is the backup approver when the manager is absent.' })}</div>
      </div></div>`;
  const email = `<div class="float email" data-at="b2+4.6" data-out="b3" data-anim="up" style="left:1330px;top:560px;width:480px"><div class="eh">${ic('LuMail', 'width="16" height="16"')}<span>[${ORG}] Approval needed: Shift change — Noor Al Siyabi</span></div>
      <div class="eb"><div style="font-size:12px;color:#667085">FlowZa Time · ${ORG}</div><b style="font-size:15px;color:#101828;display:block;margin:6px 0">Shift change — Noor Al Siyabi is waiting for your approval</b><div style="margin-bottom:12px">18 Oct → 22 Oct 2026 · Level 1</div>${btn('Review the request', { cls: 'sm' })}
      <div style="margin-top:12px;font-size:13px">Or decide from this e-mail: <span class="link">Approve</span> · <span class="link">Reject</span></div><div class="hint" style="margin-top:6px;font-size:12px">You will be asked to confirm in FlowZa Time before anything is recorded.</div></div></div>`;
  const level = (
    n,
    appr,
    help,
    esc,
    after,
  ) => `<div class="opt-block" data-at="b3+${n === 1 ? '0.8' : '1.6'}" data-anim="up"><div class="row" style="justify-content:space-between"><span class="pill-s">Level ${n}</span><span class="hint">${ic('LuArrowUp', 'width="14" height="14"')} ${ic('LuArrowDown', 'width="14" height="14"')} ${ic('LuTrash2', 'width="14" height="14"')}</span></div>
      <div class="grid3" style="gap:10px;margin-top:8px">${F('Approver', I(appr, { sel: 1 }))}${F('Decision', I('Any one', { sel: 1 }))}${F('Escalate', I(esc, { sel: 1 }))}</div>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span class="hint">${help}</span>${after ? `<span class="row" style="gap:6px;font-size:13px;color:#344054">After (hours) <b class="inp" style="height:30px;width:60px">${after}</b></span>` : ''}</div></div>`;
  const wfPage = `<div class="crumb">${ic('LuArrowLeft')} Approvals</div><div class="ph"><div><h2>Approval workflows</h2><p style="max-width:640px">Who approves what, in which order. A branch-specific workflow wins over an organisation-wide one, and the highest tier a request reaches applies. Without a workflow, HR's own entries apply at once and everybody else's go to the holders of the approve permission.</p></div>${btn('Add workflow', { icon: 'LuPlus' })}</div>`;
  const wfDlg = modal(
    'b3+0.2',
    'end+1',
    'left:60px;top:40px;width:830px',
    `
    ${mhead('Add workflow', 'Up to 5 levels, decided in order.')}
    <div class="grid3" style="gap:10px">${F('Name', I('Leave — manager, then HR'), { req: 1 })}${F('Request type', I('Leave', { sel: 1 }))}${F('Branch', I('All branches', { sel: 1, ph: 1 }), { opt: 1 })}</div>
    <div class="row" style="justify-content:space-between;margin:14px 0 8px"><b style="font-size:14px">Levels</b><span class="hint">2 of 5</span></div>
    <div style="display:flex;flex-direction:column;gap:10px" data-hl="b3+2.2~b3+3.6">${level(1, 'Manager', 'The employee’s manager; the secondary manager when the manager is absent or on leave, then HR.', 'The next level’s approvers', '24')}${level(2, 'HR admins', 'Every HR admin of the branch.', 'Never', '')}</div>
    <div style="margin-top:10px">${btn('Add level', { cls: 'ghost sm', icon: 'LuPlus' })}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Create')}</div>`,
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
        ['b2+0.3', 'LuCheckCheck', 'Approve, reject, ask; <b>bulk or e-mail</b>'],
        ['b3+0.3', 'LuWorkflow', 'HR workflows: <b>up to 5 levels</b>, escalation'],
      ],
    }) +
      shell({
        active: 'appr',
        url: '/approvals',
        content,
        overlay: approveDlg,
        badge: 5,
        user: FATMA,
        attrs: 'data-out="b3"',
      }) +
      shell({
        active: 'appr',
        url: '/approvals/workflows',
        content: wfPage,
        overlay: wfDlg,
        attrs: 'data-at="b3-0.1" data-anim="fade"',
      }) +
      panel +
      profile +
      email +
      floatToast('b2+1.3', 'b2+2.6', 'Level approved — waiting for the next approver', '') +
      floatToast('b2+2.6', 'b2+4.1', 'Question sent', '') +
      floatToast('b2+4.1', 'b3', '2 requests approved', '') +
      CURSOR(
        'b2-0.4:1500,820|b2+0.3:#a-ap0|b2+1.1:#a-confirm|b2+1.6:#a-row3 ~ 140 ~ 30|b2+2.2:#a-ask|b2+3.0:#a-cb1|b2+3.3:#a-cb2|b2+3.9:#a-bulk',
        'b2+0.3|b2+1.1|b2+1.6|b2+2.2|b2+3.0|b2+3.3|b2+3.9',
        'b2+4.4',
      ),
  );
};

// ---------------------------------------------------------------- 8. Shift swap
// /my/shift (Enterprise module shift_requests): Today, "Next 14 days", "Assignment history", "Shift swaps"; the swap goes to the
// requester's line manager; the colleague never approves; both schedules change for that day only.
export const swapScene = () => {
  const dot = (c) =>
    `<i style="width:10px;height:10px;border-radius:50%;background:${c};display:inline-block;flex:none"></i>`;
  const line = (date, shift, color, badge, extra = '') =>
    `<div class="row" style="padding:9px 14px;border-top:1px solid #eef0f3;gap:12px" ${extra}>${dot(color)}<span style="width:96px;font-weight:600;color:#344054;font-size:14px">${date}</span><span style="flex:1;font-size:14px">${shift}</span>${badge}</div>`;
  const M = 'Morning 06:00–14:00',
    E = 'Evening 14:00–22:00';
  const days = [
    ['Mon 12 Oct', M],
    ['Tue 13 Oct', M],
    ['Wed 14 Oct', M],
    ['Thu 15 Oct', 'swap'],
    ['Fri 16 Oct', 'Day off'],
    ['Sat 17 Oct', 'Day off'],
  ];
  const content = `
    <div class="ph"><div><h2>My shift</h2><p>Your working pattern for the coming days, where it comes from, and your shift swaps.</p></div><div class="row">${btn('Request a shift change', { cls: 'ghost', icon: 'LuRepeat' })}${btn('Request a swap', { icon: 'LuArrowLeftRight', id: 's-swap' })}</div></div>
    <div class="card" style="padding:12px 16px;margin-bottom:12px"><div class="vendor row" style="gap:6px">${ic('LuCalendarClock', 'width="14" height="14"')}Today</div><div class="row" style="gap:12px;margin-top:6px">${dot('#2e90fa')}<b style="font-size:16px">Sunday, 11 October</b><span style="font-size:15px">${M}</span><span style="margin-left:auto" class="pill-s">Assigned</span></div></div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
      <div class="card" style="padding:0;overflow:hidden"><div style="padding:12px 14px;font-weight:700">Next 14 days</div>
        ${days
          .map(([d, s]) =>
            s === 'swap'
              ? line(
                  d,
                  swap('b1+1.8', M, `<b style="color:#4a1fb8">${E}</b>`),
                  '#2e90fa',
                  `<span data-at="b1+0.2">${swap('b1+1.8', chip('Swap pending with Yousuf Al Hinai', 'amber', 'class="nodot" style="height:22px;font-size:12px"'), chip('Swapped with Yousuf Al Hinai', 'violet', 'class="nodot" style="height:22px;font-size:12px"'))}</span>`,
                  'id="s-thu" data-hl="b1+1.9~end"',
                )
              : line(
                  d,
                  s === 'Day off' ? '<span class="muted">Day off</span>' : s,
                  s === 'Day off' ? '#d0d5dd' : '#2e90fa',
                  s === 'Day off' ? '' : '<span class="pill-s">Assigned</span>',
                ),
          )
          .join('')}
      </div>
      <div class="card" style="padding:12px 14px"><b>Assignment history</b><div style="margin-top:10px;font-size:14px"><b style="font-weight:600">Morning</b> <span class="pill-s">Team</span><div class="hint">From 01 Sep 2026</div></div><div style="margin-top:10px;font-size:14px"><b style="font-weight:600">General</b> <span class="pill-s">Organisation</span><div class="hint">01 Jan 2026 → 31 Aug 2026</div></div></div>
    </div>
    <div class="card" style="margin-top:12px"><div style="padding:12px 14px;font-weight:700;border-bottom:1px solid #eef0f3">Shift swaps</div>
      <table class="tbl tight"><tr><th>Day</th><th>Between</th><th>Shifts</th><th>Status</th><th>Reason / decision</th></tr>
      <tr data-at="b1+0.2" style="background:#fcfcfd"><td class="strong">Thu 15 Oct</td><td>You ⇄ Yousuf Al Hinai</td><td>Morning ⇄ Evening</td><td>${swap('b1+1.8', chip('Pending', 'amber'), chip('Approved'))}</td><td class="muted">Family appointment in the morning</td></tr></table></div>`;
  const ov = modal(
    'b0+1.2',
    'b1',
    'left:130px;top:60px;width:680px',
    `
    ${mhead('Request a shift swap', 'Pick a day and a colleague: you work their shift and they work yours. Your manager decides; the swap applies to that day only.')}
    ${F('Day', I('Thu 15 Oct · Morning 06:00–14:00', { sel: 1, id: 's-day', focus: 'b0+2.0~b0+2.8' }), { req: 1 })}
    <div class="hint" style="margin:6px 0 10px">Your shift: Morning 06:00–14:00</div>
    ${F(
      'Colleague',
      `<div class="inp" style="height:36px">${ic('LuSearch', 'width="15" height="15" style="color:#98a2b3"')}<span class="ph-t">Search colleagues</span></div>
      <div style="border:1px solid var(--border);border-radius:10px;margin-top:6px;overflow:hidden">${[
        ['Yousuf Al Hinai', 'E-1031', E, true],
        ['Said Al Mamari', 'E-1052', E, false],
      ]
        .map(
          ([n, num, s, on]) =>
            `<div class="row" ${on ? 'id="s-col" data-cls="b0+3.0:sel-row"' : ''} style="padding:8px 12px;justify-content:space-between;border-top:1px solid #eef0f3;font-size:14px"><span class="row" style="gap:8px">${av(n, on ? 2 : 7, 'width:26px;height:26px;font-size:10.5px')}<b style="font-weight:600">${n}</b><span class="mono muted" style="font-size:12px">${num}</span></span><span class="muted">${s}</span></div>`,
        )
        .join('')}</div>`,
      { req: 1 },
    )}
    <div style="margin-top:10px">${F('Reason', I('Family appointment in the morning', { type: 'b0+3.4', cps: 34 }), { req: 1 })}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Send request', { id: 's-send', icon: 'LuSend' })}</div>`,
  );
  const notice = `<div class="float card" data-at="b1+1.9" data-anim="down" style="left:1420px;top:150px;width:400px;padding:14px 16px;box-shadow:0 20px 40px -10px rgba(16,24,40,.35)"><div class="row" style="gap:10px;align-items:flex-start"><span class="ico">${ic('LuBell')}</span><div><b style="font-size:14.5px">Shift swap on 15 Oct 2026 approved</b><div class="hint">Your shift for that day has changed.</div><span class="link" style="display:inline-block;margin-top:6px">View my shift</span></div></div></div>`;
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
      notice +
      floatToast('b1+0.0', 'b1+1.8', 'Swap requested. Your manager has been notified.', '') +
      CURSOR(
        'b0+0.4:900,800|b0+1.0:#s-swap|b0+2.1:#s-day|b0+3.0:#s-col|b0+4.6:#s-send',
        'b0+1.0|b0+2.1|b0+3.0|b0+4.6',
        'b1+0.4',
      ),
  );
};

// ---------------------------------------------------------------- 9. Settings & dashboard
export const dashboard = () => {
  const ADMIN = ['Aisha Al Balushi', 'AB'];
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
    Security: 'b0+5.9~b0+7.2',
  };
  const snav = (on, hl = {}) =>
    `<div class="snav">${groups.map((g) => `<div class="${g === on ? 'on' : ''}" ${hl[g] ? `data-cls="${hl[g]}:on"` : ''}>${g}</div>`).join('')}</div>`;
  const scard = (title, icon, body, hl, at) =>
    `<div class="card" style="padding:12px 14px" data-at="${at}" data-hl="${hl}"><div class="row" style="margin-bottom:6px"><span class="ico" style="width:30px;height:30px">${ic(icon)}</span><b style="font-size:15px">${title}</b></div>${body}</div>`;
  const kv = (k, v) =>
    `<div class="row" style="justify-content:space-between;font-size:13px;padding:3px 0;color:#475467"><span>${k}</span><b style="color:#101828;font-weight:600">${v}</b></div>`;
  const swRow = (k) =>
    `<div class="row" style="justify-content:space-between;font-size:13px;color:#475467;padding:3px 0">${k} ${sw()}</div>`;
  const header = `<div class="ph"><div><h2>Settings</h2><p>Organisation profile, dashboard style, regional formats, attendance, synchronisation, integrations, reports, notifications, security and subscription.</p></div></div>`;
  const winA = `${header}
    <div style="display:flex;gap:16px">${snav('', hlA)}
      <div class="grid2" style="flex:1;gap:10px;align-content:start">
        ${scard('Region &amp; language', 'LuGlobe', kv('Timezone', 'Asia/Muscat') + '<div class="hint">Branches can override this.</div>' + kv('Weekly off days', 'Fri, Sat'), hlA.Regional, 'b0+0.4')}
        ${scard('Attendance processing', 'LuClock', kv('Default shift', 'General') + swRow('Detect missed punches'), hlA.Attendance, 'b0+0.6')}
        ${scard('Device synchronisation', 'LuRefreshCw', kv('Default poll interval (min)', '5') + swRow('Push new employees automatically'), hlA.Sync, 'b0+0.8')}
        ${scard('Organisation e-mails', 'LuBell', swRow('Approval requests') + swRow('Device offline'), hlA.Notifications, 'b0+1.0')}
        ${scard('Security policy', 'LuShieldCheck', swRow('Require two-factor authentication') + kv('Session idle timeout (min)', '480'), hlA.Security, 'b0+1.2')}
      </div></div>`;
  const roles = `<div class="float card" data-at="b0+7.3" data-out="b1" data-anim="up" style="left:980px;top:560px;width:840px;padding:0;overflow:hidden;box-shadow:0 30px 60px -12px rgba(16,24,40,.35)">
      <div style="padding:14px 18px 0"><div class="row" style="justify-content:space-between"><b style="font-size:17px">Users &amp; roles</b><span class="hint">/users</span></div><div class="hint" style="margin:2px 0 8px">Who can sign in to this organisation, what they may do, and which branches they see.</div>
      <div class="tabs" style="margin-bottom:0"><span class="on">Members</span><span>Invitations</span><span>Roles</span></div></div>
      <table class="tbl tight"><tr><th>Name</th><th>Role</th><th>Branch scope</th><th>Status</th></tr>
      ${[
        ['Aisha Al Balushi', 'Organisation Admin', ['All branches'], 0],
        ['Fatma Al Rawahi', 'Line Manager', ['Muscat HQ'], 1],
        ['Rashid Al Saadi', 'Branch Manager', ['Sohar', 'Salalah'], 5],
      ]
        .map(
          ([n, r, b, c]) =>
            `<tr><td>${who(n, '', c)}</td><td>${r}</td><td>${b.map((x) => `<span class="pill-s">${x}</span>`).join(' ')}</td><td>${chip('Active')}</td></tr>`,
        )
        .join('')}</table></div>`;
  const themes = [
    ['FlowZa Green', '#0e2b25', '#137a5d'],
    ['Midnight Indigo', '#161a3f', '#4f46e5'],
    ['Classic Light', '#ffffff', '#2563eb'],
    ['Desert Gold', '#2a1a10', '#d97706'],
    ['Ocean Teal', '#052e36', '#0d9488'],
    ['Graphite', '#18181b', '#52525b'],
    ['Crimson', '#2b0b12', '#e11d48'],
  ];
  const winB = `${header}
    <div style="display:flex;gap:16px">${snav('Dashboard')}
      <div style="flex:1"><div class="card" style="padding:16px 18px">
        <b style="font-size:17px">Dashboard style</b><div class="hint" style="margin:2px 0 10px">How the dashboard and the app look for everyone in this organisation. Your choice is previewed as you click and applied for all members when you save.</div>
        <div style="font-size:13.5px;font-weight:600;color:#344054">Style <span class="hint" style="font-weight:450">· Colours of the sidebar, buttons and charts.</span></div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:6px">${themes.map(([n, sb, br], k) => `<div class="thm ${k === 0 ? 'on' : ''}" id="th${k}" data-at="b1+${(0.4 + k * 0.16).toFixed(2)}" data-anim="pop"><div class="pv" style="height:60px"><div class="sb" style="background:${sb};${sb === '#ffffff' ? 'border-right:1px solid #e4e7ec' : ''}"></div><div class="ct"><i style="background:${br};width:60%"></i><i style="background:#e4e7ec;width:85%"></i><i style="background:#e4e7ec;width:70%"></i></div></div><div class="nm">${n}</div></div>`).join('')}</div>
        <div style="font-size:13.5px;font-weight:600;color:#344054;margin-top:12px">Layout <span class="hint" style="font-weight:450">· Which widgets the dashboard shows, and what comes first.</span></div>
        <div class="grid3" style="gap:8px;margin-top:6px">${[
          [
            'Overview',
            "Balanced: today's numbers, the trend, branches, recent activity, approvals and holidays.",
          ],
          [
            'Operations',
            "Devices, sync jobs and today's punches first — for attendance and IT teams.",
          ],
          [
            'Executive',
            'Compact: headline numbers with sparklines, the trend and branches. No side rail.',
          ],
        ]
          .map(
            ([n, d], k) =>
              `<div class="lay ${k === 0 ? 'on' : ''}" id="ly${k}" data-hl="b1+${(3.4 + k * 0.8).toFixed(1)}~b1+${(4.2 + k * 0.8).toFixed(1)}" style="padding:10px 12px"><b>${n}</b><p>${d}</p></div>`,
          )
          .join('')}</div>
        <div class="row" style="gap:18px;margin-top:12px;font-size:13px;color:#344054;flex-wrap:wrap"><span class="row" style="gap:8px">Trend range <span class="inp sel" style="height:30px;width:110px;font-size:13px">14 days</span></span><span class="row" style="gap:6px">${sw()} Personal greeting</span><span class="row" style="gap:6px">${sw()} Highlight card</span><span class="row" style="gap:6px">${sw()} Quote of the day</span></div>
      </div></div></div>`;
  // ---- the dashboard itself (Overview layout, full width)
  const C = { on: '#1f9873', late: '#f59e0b', abs: '#ef4444', lv: '#3b82f6', off: '#d0d5dd' };
  const kpis = [
    ['Total employees', 468, 'LuUsers', null, 'active employees', null],
    ['Present today', 412, 'LuUserCheck', '+14', '88% of employees', 88],
    ['Absent', 14, 'LuUserX', '−3', '3% of employees', 3],
    ['On leave', 23, 'LuTreePalm', null, '5% of employees', 5],
    ['Late', 19, 'LuClock', '−5', '4% of employees', 4],
    ['Early departure', 6, 'LuLogOut', null, '1% of employees', 1],
  ];
  const kpiHl = ['', 'b2+2.0~b2+2.7', 'b2+2.7~b2+3.2', 'b2+3.2~b2+3.8', 'b2+3.8~b2+4.6', ''];
  const kpiHtml = kpis
    .map(
      (
        [l, v, i, d, h, p],
        k,
      ) => `<div class="card kpi" style="padding:12px 14px;position:relative;overflow:hidden" data-at="b2+${(0.3 + k * 0.15).toFixed(2)}" data-hl="${kpiHl[k]}"><div class="l"><span class="ico" style="width:28px;height:28px">${ic(i)}</span>${l}</div><div class="v tnum" style="font-size:30px" data-count="0,${v}" data-count-at="b2+${(0.3 + k * 0.15).toFixed(2)}">${v}</div>
      <div class="row" style="justify-content:space-between;font-size:12px;margin-top:2px"><span style="color:#067647;font-weight:600">${d ? `${d} vs last week` : ''}</span><span class="muted">${h}</span></div>${p != null ? `<div style="position:absolute;left:0;right:0;bottom:0;height:4px;background:#f2f4f7"><div class="bbar" data-bar="${p}" data-bar-at="b2+${(0.5 + k * 0.15).toFixed(2)}" style="height:4px;border-radius:0"></div></div>` : ''}</div>`,
    )
    .join('');
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
  const tdays = [
    '28 Sep',
    '29',
    '30',
    '1 Oct',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '10',
    '11 Oct',
  ];
  const trendHtml = `<div class="trend" style="height:170px">${trend
    .map(
      (v, k) =>
        `<div class="col" data-at="b2+${(3.9 + k * 0.05).toFixed(2)}" data-anim="grow">${[
          ['on', 0],
          ['late', 1],
          ['abs', 2],
          ['lv', 3],
        ]
          .map(([c, i]) => `<i style="height:${(v[i] / 470) * 100}%;background:${C[c]}"></i>`)
          .join('')}</div>`,
    )
    .join('')}</div>
    <div class="row" style="gap:10px;padding:6px 4px 0;font-size:11px;color:#667085">${tdays.map((d) => `<span style="flex:1;text-align:center;white-space:nowrap">${d}</span>`).join('')}</div>`;
  const slices = [
    ['Present · on time', 393, C.on],
    ['Late', 19, C.late],
    ['Absent', 14, C.abs],
    ['On leave', 23, C.lv],
    ['Off / no record', 19, C.off],
  ];
  let acc = 0;
  const donut = `<svg viewBox="0 0 140 140" width="150" height="150">${slices
    .map(([, v, c]) => {
      const s = `<circle cx="70" cy="70" r="56" fill="none" stroke="${c}" stroke-width="18" stroke-dasharray="${(v / 468) * 351.9 - 2} 351.9" stroke-dashoffset="${-(acc / 468) * 351.9}" transform="rotate(-90 70 70)"/>`;
      acc += v;
      return s;
    })
    .join(
      '',
    )}<text x="70" y="70" text-anchor="middle" font-size="26" font-weight="750" fill="#101828" font-family="Inter">468</text><text x="70" y="88" text-anchor="middle" font-size="11" fill="#667085" font-family="Inter">Employees</text></svg>`;
  const branchRows = [
    ['Muscat HQ', 'MCT', 197, 214],
    ['Sohar', 'SOH', 86, 96],
    ['Dubai', 'DXB', 43, 48],
    ['Salalah', 'SLL', 56, 71],
    ['Riyadh', 'RUH', 30, 39],
  ];
  const activity = [
    ['Salim Al Harthy', 'Checked in · Sohar', '07:56', C.on, 2],
    ['Yousuf Al Hinai', 'Late check-in · Muscat HQ', '08:24', C.late, 2],
    ['Noor Al Siyabi', 'Checked in · Muscat HQ', '07:49', C.on, 5],
    ['Fatma Al Rawahi', 'Checked in · Muscat HQ', '07:41', C.on, 1],
  ];
  const winC = `
    <div class="row" style="justify-content:space-between;margin-bottom:12px"><div><h2 style="font-size:26px;letter-spacing:-.02em">Good morning, Aisha!</h2><p style="font-size:14.5px;color:#475467;margin-top:2px">Here's what's happening at ${ORG} today.</p></div>
      <div class="row" style="gap:12px"><span class="row" style="gap:6px;font-size:13px;color:#475467"><i style="width:8px;height:8px;border-radius:50%;background:#12b76a;display:inline-block"></i>Updated 1 minute ago</span><span class="seg"><span>${ic('LuChevronLeft', 'width="14" height="14"')}</span><span class="on">Sun, 11 Oct 2026</span><span>${ic('LuChevronRight', 'width="14" height="14"')}</span></span></div></div>
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px">${kpiHtml}</div>
    <div style="display:grid;grid-template-columns:9fr 3fr;gap:12px;margin-top:12px">
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="display:grid;grid-template-columns:3fr 2fr;gap:12px">
          <div class="card" style="padding:14px 16px" data-at="b2+3.8" data-hl="b3+0.2~b3+1.6"><div class="row" style="justify-content:space-between;margin-bottom:10px"><div><b style="font-size:15.5px">Attendance trend</b><div class="hint">Daily attendance for the last 14 days</div></div><div class="legend" style="font-size:12px"><span><i style="background:${C.on}"></i>On time</span><span><i style="background:${C.late}"></i>Late</span><span><i style="background:${C.abs}"></i>Absent</span><span><i style="background:${C.lv}"></i>On leave</span></div></div>${trendHtml}</div>
          <div class="card" style="padding:14px 16px" data-at="b2+4.2"><b style="font-size:15.5px">Today's attendance</b><div class="row" style="gap:14px;margin-top:8px">${donut}<div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:#344054;flex:1">${slices.map(([l, v, c]) => `<div class="row" style="justify-content:space-between;gap:6px"><span class="row" style="gap:6px"><i style="width:9px;height:9px;border-radius:3px;background:${c};display:inline-block"></i>${l}</span><b class="tnum">${v} <span class="muted" style="font-weight:450">${Math.round((v / 468) * 100)}%</span></b></div>`).join('')}</div></div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="card" style="padding:14px 16px" data-at="b3+0.8" data-hl="b3+1.7~b3+3.2"><b style="font-size:15.5px">Attendance by branch</b><div class="hint">Present out of active employees, per branch</div>
            <table class="tbl tight" style="margin-top:6px"><tr><th>#</th><th>Branch</th><th>Present / Total</th><th>Attendance %</th></tr>${branchRows.map(([n, c, p, t], k) => `<tr><td><span class="pill-s">${k + 1}</span></td><td><b style="font-weight:600">${n}</b> <span class="mono muted" style="font-size:11.5px">${c}</span></td><td class="tnum">${p} / ${t}</td><td class="tnum"><span class="row" style="gap:6px"><b>${Math.round((p / t) * 100)}%</b><span class="btrack" style="height:6px;width:60px;flex:none"><span class="bbar" style="display:block;height:6px" data-bar="${Math.round((p / t) * 100)}" data-bar-at="b3+1.0"></span></span></span></td></tr>`).join('')}</table></div>
          <div class="card" style="padding:14px 16px" data-at="b3+1.2" data-hl="b3+3.2~b3+4.6"><div class="row" style="justify-content:space-between"><b style="font-size:15.5px">Recent activity</b><span class="link" style="font-size:12.5px">View all</span></div>
            <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">${activity.map(([n, s, t, c, col]) => `<div class="row" style="gap:10px"><i style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block;flex:none"></i>${av(n, col, 'width:28px;height:28px;font-size:11px')}<div style="flex:1"><b style="font-weight:600;font-size:13.5px">${n}</b><div class="hint" style="font-size:12px">${s}</div></div><span class="tnum muted" style="font-size:13px">${t}</span></div>`).join('')}</div></div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="card" data-at="b2+4.4" style="padding:16px;background:linear-gradient(135deg,#0f6e56,#1f9873);color:#fff;border:0"><b style="font-size:17px;line-height:1.3;display:block">People on time. Business on track.</b><div style="font-size:13px;opacity:.85;margin:6px 0 10px">Accurate attendance. Smarter teams. A stronger tomorrow.</div><span style="background:#fff;color:#0f6e56;border-radius:8px;padding:6px 10px;font-size:13px;font-weight:700">Explore reports →</span></div>
        <div class="card" style="padding:14px 16px" data-at="b3+1.6" data-hl="b3+4.6~b3+6.2"><div class="row" style="justify-content:space-between"><b style="font-size:15.5px">Awaiting your approval</b><span class="badge" style="background:#d92d20;color:#fff;border-radius:99px;font-size:11.5px;font-weight:700;padding:1px 8px">3</span></div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">${[
            ['LuTreePalm', 'Leave', 'Maryam Al Kindi', '2 hours ago'],
            ['LuCalendarClock', 'Shift change', 'Noor Al Siyabi', '3 hours ago'],
            ['LuClipboardCheck', 'Regularisation', 'Hamed Al Busaidi', 'yesterday'],
          ]
            .map(
              ([i, l, n, a]) =>
                `<div class="row" style="gap:10px"><span class="ico" style="width:30px;height:30px">${ic(i)}</span><div style="flex:1"><b style="font-weight:600;font-size:13.5px">${l}</b><div class="hint" style="font-size:12px">${n}</div></div><span class="muted" style="font-size:12px">${a}</span></div>`,
            )
            .join('')}</div></div>
      </div>
    </div>`;
  const reports = `<div class="float card" data-at="b3+6.0" data-anim="down" style="left:860px;top:96px;padding:10px 16px;box-shadow:0 20px 40px -10px rgba(16,24,40,.35);display:flex;gap:12px;align-items:center;z-index:30"><span class="ico">${ic('LuFileText')}</span><div><b style="font-size:15px">Reports</b><div class="hint">Daily, monthly, late, absence, leave…</div></div>${['PDF', 'Excel (XLSX)', 'CSV'].map((f, k) => `<span data-at="b3+${(6.4 + k * 0.4).toFixed(1)}" data-anim="pop">${chip(f, 'teal', 'class="nodot"')}</span>`).join('')}</div>`;
  return scene(
    'dashboard',
    `<div data-out="b2" data-anim="fade">${side({
      n: 9,
      kicker: 'Configure & dashboard',
      title: 'Configure once, <em>watch it live</em>',
      points: [
        ['b0+2.0', 'LuSettings', 'Regional, attendance, sync, <b>notifications, security</b>'],
        ['b0+7.4', 'LuShieldCheck', '<b>Roles</b> and branch scope'],
        ['b1+0.3', 'LuPalette', '<b>7 styles</b> and 3 layouts'],
      ],
    })}</div>` +
      shell({
        active: 'set',
        url: '/settings/regional',
        content: winA,
        user: ADMIN,
        attrs: 'data-out="b1"',
      }) +
      shell({
        active: 'set',
        url: '/settings/dashboard',
        content: winB,
        user: ADMIN,
        attrs: 'data-at="b1" data-out="b2" data-anim="fade"',
      }) +
      shell({
        active: 'dash',
        url: '/',
        content: winC,
        cls: 'wide',
        user: ADMIN,
        attrs: 'data-at="b2-0.1" data-anim="zoom" data-d="0.7"',
      }) +
      roles +
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
