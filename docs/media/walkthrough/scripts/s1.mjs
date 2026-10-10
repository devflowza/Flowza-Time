import { ic, LOGO, CURSOR, shell, side } from './kit.mjs';
import { av, who, chip, tag, swap, F, I, btn, sw, toast, modal, mhead, scene } from './h.mjs';

export const intro = () =>
  scene(
    'intro',
    `
  <div style="position:absolute;left:0;right:0;top:150px;display:flex;flex-direction:column;align-items:center;text-align:center">
    <div data-at="0.1" data-anim="pop" data-d="0.8">${LOGO.replace('class="logo"', 'style="width:120px;height:120px;filter:drop-shadow(0 18px 40px rgba(93,211,158,.35))"')}</div>
    <div class="intro-title" data-at="0.5" style="margin-top:26px">FlowZa Time <span style="display:inline-block;vertical-align:middle;font-size:30px;font-weight:700;letter-spacing:.06em;padding:8px 18px;border-radius:99px;background:rgba(93,211,158,.16);color:#78cfaf;margin-left:10px;transform:translateY(-8px)">ENTERPRISE</span></div>
    <div data-at="1.2" style="font-size:32px;color:#b9d3ca;margin-top:12px;font-weight:450">Cloud attendance &amp; workforce time management for the GCC</div>
  </div>
  <div class="agenda" style="position:absolute;left:340px;top:560px">
    ${[
      ['LuCpu', 'Devices'],
      ['LuBuilding2', 'Branches & sites'],
      ['LuUsers', 'Employees & shifts'],
      ['LuCalendarClock', 'Shift changes'],
      ['LuArrowRightLeft', 'Branch deployments'],
      ['LuTreePalm', 'Leave'],
      ['LuSquareCheck', 'Manager approvals'],
      ['LuRepeat', 'Shift swaps'],
      ['LuLayoutDashboard', 'Settings & dashboard'],
    ]
      .map(
        ([i, t], k) =>
          `<div class="a" data-at="b1+${(k * 0.17).toFixed(2)}" data-anim="pop"><span class="k">${ic(i)}</span><div><small>${String(k + 1).padStart(2, '0')}</small><b>${t}</b></div></div>`,
      )
      .join('')}
  </div>`,
    'dark',
  );

// ---------------------------------------------------------------- 1. Devices
export const devices = () => {
  const rows = [
    ['MCT-01', 'Main entrance', 'ZKTeco PUSH / ADMS', 'Muscat HQ', chip('Online'), '2 min ago'],
    ['SOH-01', 'Sohar gate', 'Hikvision ISAPI event push', 'Sohar', chip('Online'), '4 min ago'],
    ['SLL-01', 'Salalah lobby', 'Suprema BioStar 2', 'Salalah', chip('Online'), '1 min ago'],
    [
      'RUH-01',
      'Riyadh office',
      'Anviz CrossChex Cloud',
      'Riyadh',
      chip('Vendor degraded', 'amber'),
      '26 min ago',
    ],
  ];
  const tr = (r, extra = '') =>
    `<tr ${extra}><td class="strong"><span class="mono" style="font-size:13.5px">${r[0]}</span><small style="display:block;font-weight:450;color:#667085;font-size:12.5px">${r[1]}</small></td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td><td class="muted">${r[5]}</td></tr>`;
  const provs = [
    ['p-zk', 'ZKTeco PUSH / ADMS', 'Device push'],
    ['p-hik', 'Hikvision ISAPI event push', 'Device push'],
    ['p-sup', 'Suprema BioStar 2', 'On-premise server'],
    ['p-anv', 'Anviz CrossChex Cloud', 'Vendor cloud'],
    ['p-mat', 'Matrix COSEC', 'LAN'],
    ['p-bio', 'ZKBio Time / BioTime REST', 'On-premise server'],
  ];
  const content = `
    <div class="ph"><div><h2>Devices &amp; punches</h2><p>Terminals and vendor accounts that send punches to FlowZa.</p></div>
      <div class="row">${btn('Sync attendance', { cls: 'ghost', icon: 'LuRefreshCw' })}${btn('Register device', { id: 'd-reg', icon: 'LuPlus' })}</div></div>
    <div class="tabs"><span class="on">Devices</span><span>PIN mapping</span><span>Unmapped punches</span><span>Punch log</span></div>
    <div class="grid3" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
      ${[
        ['Online', '18', 'c-green'],
        ['Offline', '1', 'c-red'],
        ['Degraded', '1', 'c-amber'],
        ['Unknown', '0', 'c-gray'],
      ]
        .map(
          ([l, v, c]) =>
            `<div class="card kpi"><div class="l"><span class="chip ${c}" style="height:22px">${l}</span></div><div class="v tnum" style="font-size:30px">${v}</div></div>`,
        )
        .join('')}
    </div>
    <div class="card"><table class="tbl"><tr><th>Device</th><th>Provider</th><th>Branch</th><th>Connection</th><th>Last punch</th></tr>
      ${rows.map((r) => tr(r)).join('')}
      ${tr(['MCT-02', 'Reception', 'ZKTeco PUSH / ADMS', 'Muscat HQ', chip('Online'), 'just now'], 'id="d-newrow" data-at="b2+3.9" data-hl="b2+4.0~end" style="background:#f6fdf9"')}
    </table></div>`;
  const overlay =
    modal(
      'b0+2.1',
      'b2+3.5',
      'left:56px;top:60px;width:834px',
      `
    ${mhead('Register device', 'Connect a terminal or a vendor cloud account.')}
    <div class="stepper"><div class="s on"><i>1</i>Device</div><div class="s" data-cls="b1:on"><i>2</i>Details</div><div class="s" data-cls="b2:on"><i>3</i>Connection</div><div class="s"><i>4</i>Review</div></div>
    <div style="position:relative;height:350px">
      <div data-out="b1" style="position:absolute;inset:0"><div class="hint" style="margin-bottom:12px">Choose how this terminal connects. Grouped by integration type.</div>
        <div class="grid2">${provs.map(([id, n, ty], k) => `<div class="prov ${id}" data-at="b0+${(2.6 + k * 0.5).toFixed(1)}" ${id === 'p-zk' ? 'data-cls="b0+7.5:sel"' : ''}><span class="ico">${ic(k < 2 ? 'LuFingerprint' : k === 3 ? 'LuCloud' : k === 4 ? 'LuNetwork' : 'LuServer')}</span><div><div class="nm">${n}</div><div class="ty">${ty} ${tag('Beta', 'beta')}</div></div></div>`).join('')}</div></div>
      <div data-at="b1+0.05" data-out="b2" data-anim="left" style="position:absolute;inset:0"><div class="grid2" style="row-gap:18px">
        ${F('Code', I('MCT-02', { type: 'b1+0.5', id: 'd-code', focus: 'b1+0.3~b1+1.2' }))}
        ${F('Name', I('Reception', { type: 'b1+1.3', focus: 'b1+1.2~b1+2.1' }))}
        ${F('Branch', I('Muscat HQ', { sel: 1, focus: 'b1+2.1~b1+2.9' }))}
        ${F('Timezone', I('Asia/Muscat  ·  UTC+4', { sel: 1, icon: 'LuGlobe' }), { hint: 'Defaults to the branch timezone; punches are interpreted in this zone.', hl: 'b1+2.9~b2' })}
        ${F('Serial number', I('CQZ7234500183', { cls: 'mono' }))}
        ${F('Tags', I('Reception, Ground floor'))}
      </div></div>
      <div data-at="b2+0.05" data-anim="left" style="position:absolute;inset:0">
        <div class="card" style="padding:16px 18px;background:#f6fdf9;border-color:#d5f2e5;box-shadow:none"><div class="row" style="margin-bottom:10px"><span class="ico">${ic('LuRadioTower')}</span><div><b style="font-size:16px">This device contacts FlowZa (push)</b><div class="hint">Register the device here to obtain its push URL and token.</div></div></div>
          <div class="grid2"><div class="field"><label>Push URL</label><div class="code"><span>https://time.flowza.com/device-push/zk</span>${ic('LuCopy')}</div></div><div class="field"><label>Push token</label><div class="code"><span>•••• •••• •••• 7f3a</span>${ic('LuCopy')}</div></div></div></div>
        <div class="row" style="margin-top:20px">${btn('Test connection', { cls: 'ghost', id: 'd-test', icon: 'LuPlugZap' })}<span data-at="b2+1.6" data-anim="pop">${chip('Connection succeeded')}</span></div>
        <div class="row" style="margin-top:20px;gap:24px;padding:12px 14px;border:1px solid var(--border);border-radius:10px" data-at="b2+2.0"><div class="row" style="gap:8px;font-size:14px;color:#344054">${sw()} Automatic attendance sync</div><div style="font-size:14px;color:#344054">Sync interval <b>5 min</b></div><div style="font-size:14px;color:#344054">Offline threshold <b>15 min</b></div></div>
      </div>
    </div>
    <div class="mfoot" style="margin-top:0">${btn('Back', { cls: 'ghost' })}${btn('Register', { id: 'd-save', icon: 'LuCheck' })}</div>`,
    ) + toast('b2+4.3', null, 'Device registered', 'Sync job queued · Pull attendance');
  const cursor = CURSOR(
    'b0+0.6:780,760|b0+1.9:#d-reg|b0+7.4:.p-zk|b1+0.5:#d-code|b2+1.0:#d-test|b2+3.2:#d-save|b2+4.6:#d-newrow ~ 250 ~ 30',
    'b0+1.9|b0+7.4|b2+1.0|b2+3.2',
  );
  return scene(
    'devices',
    side({
      n: 1,
      kicker: 'Configure devices',
      title: 'Connect your <em>terminals</em>',
      points: [
        ['b0+3.0', 'LuFingerprint', '<b>ZKTeco, Hikvision, Suprema,</b> Anviz and Matrix'],
        ['b1+0.3', 'LuMapPin', 'Code, name and <b>branch</b>; timezone follows'],
        ['b2+0.5', 'LuPlugZap', '<b>Test the connection,</b> push URL and token'],
        ['b2+3.8', 'LuRefreshCw', 'Punches <b>sync automatically</b>'],
      ],
    }) +
      shell({ active: 'dev', url: '/devices', content, overlay }) +
      cursor,
  );
};

// ---------------------------------------------------------------- 2. Branches
export const branches = () => {
  const rows = [
    ['MCT', 'Muscat HQ', 'مسقط', 'Muscat', 'Asia/Muscat', 214],
    ['SOH', 'Sohar', 'صحار', 'Sohar', 'Asia/Muscat', 96],
    ['SLL', 'Salalah', 'صلالة', 'Salalah', 'Asia/Muscat', 71],
    ['DXB', 'Dubai', 'دبي', 'Dubai', 'Asia/Dubai', 48],
    ['RUH', 'Riyadh', 'الرياض', 'Riyadh', 'Asia/Riyadh', 39],
  ];
  const tr = (r, extra = '') =>
    `<tr ${extra}><td><span class="mono" style="font-weight:600;color:#101828">${r[0]}</span></td><td class="strong">${r[1]} <span style="font-weight:500;color:#667085;margin-left:6px;font-family:'DejaVu Sans'">${r[2]}</span></td><td>${r[3]}</td><td class="mono" style="font-size:13.5px">${r[4]}</td><td class="tnum">${r[5]}</td><td>${chip('Active')}</td></tr>`;
  const content = `
    <div class="ph"><div><h2>Organisation structure</h2><p>Branches, departments, designations and teams.</p></div>${btn('Add branch', { id: 'b-add', icon: 'LuPlus' })}</div>
    <div class="tabs"><span class="on">Branches</span><span>Departments</span><span>Designations</span><span>Teams</span></div>
    <div class="card"><table class="tbl"><tr><th>Code</th><th>Branch</th><th>City</th><th>Timezone</th><th>Employees</th><th>Status</th></tr>
      ${rows.map((r) => tr(r)).join('')}${tr(['NZW', 'Nizwa', 'نزوى', 'Nizwa', 'Asia/Muscat', 0], 'data-at="b2+0.2" data-hl="b2+0.3~b2+1.6" style="background:#f6fdf9"')}</table></div>`;
  const overlay = modal(
    'b0+1.5',
    'b2',
    'left:70px;top:58px;width:806px',
    `
    ${mhead('Add branch', 'Devices and employees are attached to a branch; its timezone drives attendance dates.')}
    <div class="grid3" style="row-gap:16px">
      ${F('Code', I('NZW', { type: 'b0+2.0', cls: 'mono', focus: 'b0+1.9~b0+2.4' }))}
      ${F('Name', I('Nizwa', { type: 'b0+2.5', focus: 'b0+2.4~b0+3.0' }))}
      ${F('Name (Arabic)', I('<span style="font-family:DejaVu Sans">نزوى</span>'))}
      ${F('City', I('Nizwa', { type: 'b0+3.1' }))}
      ${F('Country', I('Oman', { sel: 1 }))}
      ${F('Timezone', I('Asia/Muscat', { sel: 1, icon: 'LuGlobe', id: 'b-tz' }), { hl: 'b0+3.6~b1+4.6' })}
    </div>
    <div style="display:flex;gap:28px;margin-top:18px;align-items:flex-end">
      ${F('Weekly off days', `<div class="days"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span data-cls="b0+4.4:on">Fri</span><span data-cls="b0+4.6:on">Sat</span></div>`)}
      <div style="flex:1">${F('Holiday calendar', I('Oman public holidays 2026', { sel: 1, icon: 'LuCalendarDays' }), { hl: 'b0+5.2~b1' })}</div>
    </div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Save branch', { id: 'b-save' })}</div>`,
  );
  const tzCard = `<div class="float card" data-at="b1+0.3" data-out="b2+0.2" style="left:1240px;top:626px;width:560px;padding:18px 20px;box-shadow:0 20px 40px -10px rgba(16,24,40,.3)">
      <div style="font-weight:700;font-size:16px;margin-bottom:4px">One punch, two branch calendars</div><div class="hint" style="margin-bottom:12px">Same moment: 20:30 UTC</div>
      ${[
        ['Muscat HQ', 'Asia/Muscat · UTC+4', '00:30', 'Sun 11 Oct', 'b1+1.6'],
        ['Riyadh', 'Asia/Riyadh · UTC+3', '23:30', 'Sat 10 Oct', 'b1+2.6'],
      ]
        .map(
          ([b, z, t, d, a]) =>
            `<div class="row" style="justify-content:space-between;padding:10px 0;border-top:1px solid #eef0f3" data-at="${a}" data-anim="left"><div class="row"><span class="ico">${ic('LuClock')}</span><div><b style="font-size:15px">${b}</b><div class="hint mono">${z}</div></div></div><div style="text-align:right"><b class="tnum" style="font-size:20px">${t}</b><div>${chip(d, 'teal', 'style="height:22px;font-size:12px"')}</div></div></div>`,
        )
        .join('')}
    </div>`;
  const geo = `<div class="float card" data-at="b2+0.6" style="left:1388px;top:600px;width:440px;padding:16px;box-shadow:0 24px 48px -12px rgba(16,24,40,.35)">
      <div class="row" style="justify-content:space-between;margin-bottom:10px"><b style="font-size:16px">New geofence</b>${chip('Nizwa', 'teal', 'class="nodot"')}</div>
      <div class="map"><svg class="roads" viewBox="0 0 400 210" preserveAspectRatio="none"><path d="M0 150 C120 130 200 160 400 110" stroke="#fff" stroke-width="12" fill="none"/><path d="M150 0 C170 80 140 140 190 210" stroke="#fff" stroke-width="9" fill="none"/><path d="M0 60 L400 40" stroke="#fff" stroke-width="5" fill="none"/><rect x="250" y="120" width="60" height="40" rx="6" fill="#d5ebe1"/><rect x="40" y="80" width="70" height="44" rx="6" fill="#d5ebe1"/></svg>
        <div class="fence" data-at="b2+1.0" data-anim="pop"></div><div class="pin">${ic('LuMapPin')}</div></div>
      <div class="grid2" style="margin-top:12px;gap:10px">${F('Radius (m)', I('150'))}${F('Minimum GPS accuracy (m)', I('50'))}</div>
    </div>`;
  return scene(
    'branches',
    side({
      n: 2,
      kicker: 'Branches & sites',
      title: 'Every branch is a <em>site</em>',
      points: [
        ['b0+1.6', 'LuBuilding2', 'Code, city, <b>timezone,</b> weekly off days'],
        ['b0+5.0', 'LuCalendarDays', 'Its own <b>holiday calendar</b>'],
        ['b1+0.4', 'LuGlobe', 'Branch timezone sets the <b>attendance date</b>'],
        ['b2+0.5', 'LuMapPinned', '<b>Geofences</b> for mobile check-in'],
      ],
    }) +
      shell({ active: 'org', url: '/organization?tab=branches', content, overlay }) +
      tzCard +
      geo +
      CURSOR('b0+0.5:800,800|b0+1.4:#b-add|b1+0.2:#b-tz|b1+5.0:#b-save', 'b0+1.4|b1+5.0'),
  );
};

// ---------------------------------------------------------------- 3. People, departments, shifts
export const people = () => {
  const emps = [
    ['Fatma Al Rawahi', 'E-1001', 'Muscat HQ', 'Finance', 'Finance manager'],
    ['Khalid Al Amri', 'E-1017', 'Muscat HQ', 'Warehouse', 'Store keeper'],
    ['Salim Al Harthy', 'E-1023', 'Muscat HQ', 'Warehouse', 'Warehouse supervisor'],
    ['Yousuf Al Hinai', 'E-1031', 'Muscat HQ', 'Warehouse', 'Forklift operator'],
    ['Noor Al Siyabi', 'E-1038', 'Salalah', 'Sales', 'Sales executive'],
  ];
  const listA = `
    <div class="ph"><div><h2>Employees</h2><p>468 people across 6 branches</p></div><div class="row">${btn('Import from CSV', { cls: 'ghost', icon: 'LuUpload', id: 'p-imp', attrs: 'data-hl="b0+6.6~b1"' })}${btn('Add employee', { icon: 'LuPlus', id: 'p-add' })}</div></div>
    <div class="card"><table class="tbl"><tr><th>Employee</th><th>Branch</th><th>Department</th><th>Designation</th><th>Status</th></tr>
      ${emps.map((e, k) => `<tr><td>${who(e[0], e[1], k)}</td><td>${e[2]}</td><td>${e[3]}</td><td>${e[4]}</td><td>${chip('Active')}</td></tr>`).join('')}
      <tr data-at="b0+5.9" style="background:#f6fdf9"><td>${who('Maryam Al Kindi', 'E-1042', 4)}</td><td>Muscat HQ</td><td>Finance</td><td>Accountant</td><td>${chip('Active')}</td></tr></table></div>`;
  const ovA =
    modal(
      'b0+1.2',
      'b0+5.7',
      'left:60px;top:40px;width:826px',
      `
    ${mhead('Add employee', '')}
    <div style="font-size:13px;font-weight:700;color:#0f6e56;letter-spacing:.06em;text-transform:uppercase;margin:4px 0 10px">Basic information</div>
    <div class="grid2">${F('Employee number', I('E-1042', { type: 'b0+1.6', cls: 'mono', focus: 'b0+1.5~b0+2.0' }))}${F('Full name', I('Maryam Al Kindi', { type: 'b0+2.0', focus: 'b0+2.0~b0+2.8' }))}</div>
    <div style="font-size:13px;font-weight:700;color:#0f6e56;letter-spacing:.06em;text-transform:uppercase;margin:18px 0 10px">Employment</div>
    <div class="grid3" style="row-gap:14px">${F('Branch', I('Muscat HQ', { sel: 1 }), { hl: 'b0+2.6~b0+3.1' })}${F('Department', I('Finance', { sel: 1 }), { hl: 'b0+3.1~b0+3.6' })}${F('Designation', I('Accountant', { sel: 1 }), { hl: 'b0+3.6~b0+4.2' })}
      ${F('Manager', I('Fatma Al Rawahi', { sel: 1, icon: 'LuUserRound' }), { hl: 'b0+4.2~b0+5.2' })}${F('Joining date', I('01 Oct 2026', { icon: 'LuCalendar' }))}${F('Employment type', I('Full time', { sel: 1 }))}</div>
    <div style="font-size:13px;font-weight:700;color:#0f6e56;letter-spacing:.06em;text-transform:uppercase;margin:18px 0 10px">Device identity</div>
    <div class="grid2">${F('Device user id', I('Leave blank to auto-assign…', { ph: 1 }))}${F('Card number', I('Optional', { ph: 1 }))}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Create employee', { id: 'p-create' })}</div>`,
    ) +
    `<div class="float menu" data-at="b0+6.9" data-out="b1" style="right:28px;top:128px;width:300px;padding:14px"><b style="font-size:14px">Import from CSV</b><div class="hint" style="margin:4px 0 10px">Template · Upload · Review · Done</div><div class="row" style="justify-content:space-between;padding:0"><span class="hint">employees.csv · 250 rows</span>${btn('Import 250 rows', { cls: 'sm' })}</div></div>`;
  const shifts = [
    ['General', '08:00 – 17:00', 'Fixed · 1 h break', '#1f9873'],
    ['Morning', '06:00 – 14:00', 'Fixed · 30 min break', '#2e90fa'],
    ['Evening', '14:00 – 22:00', 'Fixed · 30 min break', '#7a5af8'],
    ['Night', '22:00 – 06:00 (+1)', 'Fixed · overnight', '#0e2b25'],
  ];
  const listB = `
    <div class="ph"><div><h2>Shifts &amp; schedules</h2><p>Shifts, rotations and who works when.</p></div>${btn('New shift', { icon: 'LuPlus' })}</div>
    <div class="tabs"><span class="on">Shifts</span><span>Patterns</span><span>Assignments</span><span>Rule sets</span><span>Roster</span><span>Shift requests</span></div>
    <div style="display:flex;gap:18px">
      <div style="width:300px;display:flex;flex-direction:column;gap:12px">${shifts.map(([n, t, d, c], k) => `<div class="card" style="padding:14px 16px;${k === 3 ? 'border-color:#1f9873;box-shadow:0 0 0 3px rgba(31,152,115,.15)' : ''}" data-at="b1+${(0.2 + k * 0.25).toFixed(2)}"><div class="row"><span style="width:12px;height:12px;border-radius:4px;background:${c}"></span><b style="font-size:16px">${n}</b></div><div class="tnum" style="font-size:20px;font-weight:700;margin:6px 0 2px">${t}</div><div class="hint">${d}</div></div>`).join('')}</div>
      <div class="card" style="flex:1;padding:20px 22px" data-at="b1+1.0" data-anim="left">
        <div class="row" style="justify-content:space-between;margin-bottom:14px"><h3 style="font-size:19px">Edit shift · Night</h3><span class="seg"><span class="on" data-cls="b1+2.2~b1+2.9:hl">Fixed</span><span data-cls="b1+2.9~b1+3.6:hl">Flexible</span></span></div>
        <div class="grid2">${F('Start time', I('22:00', { icon: 'LuClock' }))}${F('End time', I('06:00', { icon: 'LuClock' }), { hint: 'Earlier than start = ends the next day.', hl: 'b1+6.6~b2' })}</div>
        <div style="margin-top:16px" data-at="b1+3.8" data-hl="b1+3.8~b1+4.6"><label style="font-size:13.5px;font-weight:600;color:#344054">Breaks</label><div class="row" style="margin-top:6px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;justify-content:space-between"><span style="font-size:14.5px"><b>Meal break</b> · Duration · 30 min</span><span class="row" style="gap:8px;font-size:13.5px;color:#344054">${sw()} Paid</span></div></div>
        <div style="margin-top:16px"><label style="font-size:13.5px;font-weight:600;color:#344054">Punch windows &amp; grace</label>
          <div class="grid2" style="margin-top:6px;gap:10px">${[
            ['Custom punch-in window', '240 min before', 'b1+5.6'],
            ['Custom punch-out window', '360 min after', 'b1+5.8'],
            ['Custom grace in', '10 min', 'b1+4.6'],
            ['Custom grace out', '5 min', 'b1+4.8'],
          ]
            .map(
              ([l, v, a]) =>
                `<div class="row" data-at="${a}" style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;justify-content:space-between"><span style="font-size:13.5px;color:#475467">${l}</span><b class="tnum" style="font-size:14px">${v}</b></div>`,
            )
            .join('')}</div></div>
      </div></div>`;
  const levels = ['Organisation', 'Branch', 'Department', 'Team', 'Employee'];
  const listC = `
    <div class="ph"><div><h2>Shifts &amp; schedules</h2><p>Shifts, rotations and who works when.</p></div>${btn('Assign shift', { icon: 'LuPlus' })}</div>
    <div class="tabs"><span>Shifts</span><span>Patterns</span><span class="on">Assignments</span><span>Rule sets</span><span>Roster</span><span>Shift requests</span></div>
    <div class="card" style="padding:22px 24px">
      <h3 style="font-size:19px;margin-bottom:14px">Assign shift</h3>
      ${F('Assign to', `<span class="seg">${levels.map((l, k) => `<span data-cls="${['0', 'b2+0.9', 'b2+1.6', 'b2+2.4', 'b2+3.2'][k]}~${['b2+0.9', 'b2+1.6', 'b2+2.4', 'b2+3.2', 'end'][k]}:on">${l}</span>`).join('')}</span>`)}
      <div class="grid3" style="margin-top:16px">${F('Shift', I('Night · 22:00 – 06:00', { sel: 1 }))}${F('Effective from', I('Sun 11 Oct 2026', { icon: 'LuCalendar' }))}${F('Effective to (last day)', I('Open-ended', { ph: 1, icon: 'LuCalendar' }))}</div>
      <div style="margin-top:22px;padding:16px 18px;border-radius:12px;background:#f6fdf9;border:1px solid #d5f2e5" data-at="b2+3.8" data-anim="up">
        <div style="font-size:14px;font-weight:650;color:#0e4e3f;margin-bottom:10px">Most specific wins</div>
        <div class="flow">${levels
          .slice()
          .reverse()
          .map(
            (l, k) =>
              `${k ? `<span class="arrow">${ic('LuChevronRight')}</span>` : ''}<span class="chip ${k === 0 ? 'c-teal' : 'c-gray'} nodot" style="height:32px;font-size:14px;${k === 0 ? 'box-shadow:0 0 0 2px #1f9873' : ''}">${l}</span>`,
          )
          .join('')}</div>
      </div>
    </div>`;
  return scene(
    'people',
    side({
      n: 3,
      kicker: 'People & shifts',
      title: 'Employees, departments <em>&amp; shifts</em>',
      points: [
        ['b0+1.0', 'LuUserPlus', 'Branch, department, designation, <b>line manager</b>'],
        ['b0+6.8', 'LuUpload', '<b>Bulk import</b> from CSV'],
        ['b1+0.6', 'LuClock', 'Fixed or flexible, <b>breaks, grace,</b> punch windows'],
        ['b2+0.5', 'LuNetwork', 'Assign by branch, department, <b>team or person</b>'],
      ],
    }) +
      shell({
        active: 'emp',
        url: '/employees',
        content: listA,
        overlay: ovA,
        attrs: 'data-out="b1"',
      }) +
      shell({
        active: 'shifts',
        url: '/shifts',
        content: listB,
        attrs: 'data-at="b1" data-out="b2" data-anim="fade"',
      }) +
      shell({
        active: 'shifts',
        url: '/shifts?tab=assignments',
        content: listC,
        attrs: 'data-at="b2" data-anim="fade"',
      }) +
      CURSOR('b0+0.5:760,820|b0+1.1:#p-add|b0+5.5:#p-create|b0+6.8:#p-imp', 'b0+1.1|b0+5.5', 'b1'),
  );
};
