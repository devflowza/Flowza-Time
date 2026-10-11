import { ic, LOGO, CURSOR, shell, side } from './kit.mjs';
import { av, who, chip, tag, swap, F, I, btn, sw, cb, toast, modal, mhead, scene } from './h.mjs';

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
// Real flow (apps/web/src/features/devices): /devices hub → /devices/new full-page wizard (Device, Details, Connection,
// Review). Push terminals have no connection test; registering opens the one-time "Push credentials" dialog, and the
// new device stays "Unknown" until its first heartbeat.
const DEVICE_ROWS = [
  [
    'Main entrance',
    'MCT-01',
    'ZKTeco',
    'SpeedFace-V5L',
    'Muscat HQ',
    'Online',
    '2 minutes ago',
    '2 minutes ago',
  ],
  [
    'Sohar gate',
    'SOH-01',
    'Hikvision',
    'DS-K1T343',
    'Sohar',
    'Online',
    '4 minutes ago',
    '4 minutes ago',
  ],
  [
    'Salalah lobby',
    'SLL-01',
    'Suprema',
    'BioStation 3',
    'Salalah',
    'Online',
    '1 minute ago',
    '3 minutes ago',
  ],
  [
    'Riyadh office',
    'RUH-01',
    'Anviz',
    'FacePass 7',
    'Riyadh',
    'Degraded',
    '26 minutes ago',
    '26 minutes ago',
  ],
];
const conn = (s, when) =>
  `<span class="row" style="gap:6px">${chip(s, s === 'Online' ? 'green' : s === 'Degraded' ? 'amber' : s === 'Unknown' ? 'gray' : 'red')}${when ? `<small class="muted" style="font-size:12px">${when}</small>` : ''}</span>`;
const devRow = (r, extra = '', connCell = null) =>
  `<tr ${extra}><td><b style="color:#101828;font-weight:600">${r[0]}</b><small class="mono" style="display:block;color:#667085;font-size:12px">${r[1]}</small></td><td>${r[2]}<small style="display:block;color:#667085;font-size:12px">${r[3]}</small></td><td>${r[4]}</td><td>${connCell || conn(r[5], r[6])}</td><td>${chip('Active')}</td><td class="muted" style="font-size:13px">${r[7]}</td></tr>`;
const devicesList = (count, cards, extraRow = '') => `
  <div class="ph"><div><h2>Devices &amp; punches</h2><p>Every attendance terminal and vendor connection of the organisation.</p></div>
    <div class="row">${btn('Device groups', { cls: 'ghost', icon: 'LuFolderKanban' })}${btn('Register device', { id: 'd-reg', icon: 'LuPlus' })}</div></div>
  <div class="tabs"><span class="on">Devices</span><span>PIN mapping</span><span>Unmapped punches</span><span>Punch log</span></div>
  <div class="hint" style="margin:-4px 0 10px">${count}</div>
  <div class="grid3" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">${cards}</div>
  <div class="card"><table class="tbl tight"><tr><th>Name</th><th>Manufacturer / model</th><th>Branch</th><th>Connection</th><th>Status</th><th>Last attendance sync</th></tr>
    ${DEVICE_ROWS.map((r) => devRow(r)).join('')}${extraRow}</table></div>`;
const statCard = (label, value, tone) =>
  `<div class="card kpi" style="padding:12px 16px"><div class="l">${chip(label, tone, 'style="height:22px"')}</div><div class="v tnum" style="font-size:28px">${value}</div></div>`;

export const devices = () => {
  const cardsBefore = [
    statCard('Online', '18', 'green'),
    statCard('Offline', '1', 'red'),
    statCard('Degraded', '1', 'amber'),
    statCard('Unknown', '0', 'gray'),
  ].join('');
  const cardsAfter = [
    statCard('Online', swap('b2+7.6', '18', '19'), 'green'),
    statCard('Offline', '1', 'red'),
    statCard('Degraded', '1', 'amber'),
    statCard('Unknown', swap('b2+7.6', '1', '0'), 'gray'),
  ].join('');
  const newRow = devRow(
    ['Reception', 'MCT-02', 'ZKTeco', '—', 'Muscat HQ', '', '', '—'],
    'id="d-newrow" data-hl="b2+6.6~end" style="background:#f6fdf9"',
    swap('b2+7.6', conn('Unknown', ''), conn('Online', 'just now')),
  );
  const provs = [
    ['ZKTeco', 'ZKTeco PUSH / ADMS protocol', 'Device push', 'p-zk', 'LuRadio'],
    ['Hikvision', 'Hikvision ISAPI event push (HTTP Listening)', 'Device push', 'p-hik', 'LuRadio'],
    ['Suprema', 'Suprema BioStar 2 API', 'On-premise server', 'p-sup', 'LuPlug'],
    ['Anviz', 'Anviz CrossChex Cloud API', 'Vendor cloud', 'p-anv', 'LuPlug'],
    ['Matrix Comsec', 'Matrix COSEC device API (device.cgi)', 'LAN', 'p-mat', 'LuPlug'],
    ['ZKTeco', 'ZKBio Time / BioTime REST API', 'On-premise server', 'p-bio', 'LuPlug'],
  ];
  const steps = [
    ['Device', 'ZKTeco PUSH / ADMS protocol', 'b0+7.6', '0~b1', 'b1'],
    ['Details', 'MCT-02 · Reception', 'b1+2.4', 'b1~b2', 'b2'],
    ['Connection', 'Device push', 'b2+0.3', 'b2~b2+2.4', 'b2+2.4'],
    ['Review', 'Not chosen yet', null, 'b2+2.4~end', null],
  ];
  const rail = `<div class="rail">${steps.map(([l, sum, sumAt, on, done], k) => `<div class="r" data-cls="${on}:on${done ? `|${done}:done` : ''}"><i>${done ? swap(done, String(k + 1), ic('LuCheck', 'width="14" height="14" stroke-width="3"')) : k + 1}</i><div><b>${l}</b><small>${sumAt ? swap(sumAt, 'Not chosen yet', sum) : sum}</small></div></div>`).join('')}</div>`;
  const panel = (at, out, title, hint, body, nav) =>
    `<div ${at ? `data-at="${at}" data-anim="left"` : ''} ${out ? `data-out="${out}"` : ''} style="position:absolute;inset:0;padding:18px 20px;display:flex;flex-direction:column"><div class="cardh">${title}</div><div class="hint">${hint}</div><div style="flex:1">${body}</div><div class="row" style="justify-content:flex-end;gap:8px;border-top:1px solid #eef0f3;padding-top:12px">${nav}</div></div>`;
  const p1 = panel(
    null,
    'b1',
    'Device',
    'Pick the provider that matches your hardware, and the exact model if you know it.',
    `<div class="grid2" style="gap:10px">${provs.map(([v, n, ty, id, icon], k) => `<div class="prov ${id}" data-at="b0+${(2.8 + k * 0.45).toFixed(2)}" ${id === 'p-zk' ? 'data-cls="b0+7.5:sel"' : ''} style="padding:10px 12px;align-items:flex-start"><div style="flex:1"><div class="vendor">${v}</div><div class="nm" style="font-size:14px;line-height:1.3">${n}</div><div class="ty" style="flex-wrap:wrap">${tag(ty)}${tag('Beta', 'beta')}${tag('Reported working')}</div></div><span style="color:#667085">${ic(icon, 'width="18" height="18"')}</span></div>`).join('')}</div>`,
    btn('Next →', { id: 'd-next1', cls: 'sm' }),
  );
  const p2 = panel(
    'b1',
    'b2',
    'Details',
    'Name the device and place it in a branch.',
    `<div class="grid2" style="row-gap:12px">
      ${F('Code', I('MCT-02', { type: 'b1+0.4', cls: 'mono', id: 'd-code', focus: 'b1+0.3~b1+1.0' }), { req: 1, hint: 'Unique within the organisation; letters, digits, - _ . (max 32)' })}
      ${F('Name', I('Reception', { type: 'b1+1.0', focus: 'b1+0.9~b1+1.6' }), { req: 1 })}
      ${F('Branch', I('Muscat HQ', { sel: 1, focus: 'b1+1.6~b1+2.2' }), { req: 1 })}
      ${F('Timezone', I('Asia/Muscat', { sel: 1, cls: 'mono' }), { opt: 1, hl: 'b1+2.2~b2' })}
      ${F('Serial number', I('CQZ7234500183', { cls: 'mono' }), { req: 1, hint: 'Printed on the terminal; the device identifies itself with it when it contacts FlowZa.' })}
      ${F('Manufacturer', I('ZKTeco'), { req: 1 })}</div>`,
    btn('Back', { cls: 'ghost sm' }) + btn('Next', { id: 'd-next2', cls: 'sm' }),
  );
  const p3 = panel(
    'b2',
    'b2+2.4',
    'Connection',
    'Enter the settings the provider needs, then check that FlowZa can reach it.',
    `<div class="info" data-hl="b2+0.2~b2+2.2"><b>This device contacts FlowZa (push)</b><ol><li>Register the device here to obtain its push URL and token.</li><li>Enter the URL and token in the terminal's server / cloud settings.</li><li>The device appears online after its first heartbeat.</li></ol></div>
     <div class="grid2" style="margin-top:12px">${F('Comm key (device menu)', I('••••'), { opt: 1 })}${F('Push interval (s)', I('30'), { opt: 1 })}</div>
     <div style="margin-top:12px"><div style="font-size:13.5px;font-weight:700;color:#344054">Connection test</div><p class="hint" style="margin-top:4px">Push devices cannot be tested from here: the terminal must contact FlowZa first. Register it, configure the URL and token on the device, and watch for the first heartbeat on the device page.</p></div>`,
    btn('Back', { cls: 'ghost sm' }) + btn('Next →', { id: 'd-next3', cls: 'sm' }),
  );
  const p4 = panel(
    'b2+2.4',
    null,
    'Review',
    'Check everything, then register.',
    `<div style="display:flex;flex-direction:column;gap:10px">
      <div class="grp"><div class="gh">Device<span>Edit</span></div><div class="kv"><span>Provider</span><b>ZKTeco PUSH / ADMS protocol ${tag('Device push')}</b></div></div>
      <div class="grp"><div class="gh">Details<span>Edit</span></div><div class="kv"><span>Code</span><b class="mono">MCT-02</b></div><div class="kv"><span>Name</span><b>Reception</b></div><div class="kv"><span>Timezone</span><b class="mono">Asia/Muscat</b></div><div class="kv"><span>Serial number</span><b class="mono">CQZ7234500183</b></div></div>
      <div class="grp"><div class="gh">Connection<span>Edit</span></div><div class="kv"><span>Connection settings</span><b class="mono" style="font-size:12.5px">serialNumber=CQZ7234500183 commKey=•••• pushInterval=30</b></div></div></div>`,
    btn('Back', { cls: 'ghost sm' }) + btn('Register device', { id: 'd-save', cls: 'sm' }),
  );
  const wizard = `<div class="crumb">Devices ${ic('LuChevronRight')}</div><div class="ph"><div><h2>Register device</h2><p>Connect a terminal or a vendor cloud account.</p></div></div>
    <div style="display:flex;gap:16px">${rail}<div class="card" style="flex:1;position:relative;height:500px;overflow:hidden">${p1}${p2}${p3}${p4}</div></div>`;
  const creds = modal(
    'b2+3.3',
    'b2+5.8',
    'left:150px;top:120px;width:640px',
    `
    <div class="mhead"><div><h3 class="row" style="gap:8px">${ic('LuKeyRound', 'width="20" height="20"')}Push credentials</h3><div class="sub">Copy these now — the token is shown only once and cannot be retrieved later.</div></div><span class="mx">${ic('LuX')}</span></div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="field"><label>Push token</label><div class="code"><span>kJ3v9Qx7Lr2mWp8aZt5HcN1dYe6uBf0sGq4iVo7RwXk</span>${ic('LuCopy')}</div></div>
      <div class="field"><label>Push URL</label><div class="code"><span>…/device-push/iclock/~kJ3v9Qx7Lr2mWp8aZt5H…</span>${ic('LuCopy')}</div></div>
      <div class="amber">Enter the URL and token in the terminal's server settings (or the vendor's webhook configuration). Rotating the token invalidates the previous one immediately.</div></div>
    <div class="mfoot">${btn('Close', { cls: 'ghost', id: 'd-close' })}</div>`,
  );
  // Closing the push credentials dialog opens the new device's page; it stays Unknown until the first heartbeat.
  const detailPage = `<div class="crumb" id="d-crumb">${ic('LuArrowLeft')} Devices</div>
    <div class="ph"><div><h2>Reception</h2><p>MCT-02 · Muscat HQ · ZKTeco PUSH / ADMS protocol</p>
      <div class="row" style="gap:6px;margin-top:8px">${conn('Unknown', '')}${chip('Active')}<span class="pill-s">Device push</span><span class="pill-s mono">SN CQZ7234500183</span></div></div></div>
    <div class="tabs"><span class="on">Overview</span><span>Employees</span><span>Logs</span><span>Commands</span><span>Sync history</span><span>Settings</span></div>
    <div class="grid2" style="gap:12px">
      <div class="card" style="padding:14px 18px"><div class="cardh" style="margin-bottom:8px">Status</div>${[
        ['Connection', 'Unknown'],
        ['Status', 'Active'],
        ['Integration', 'Device push'],
        ['Last heartbeat', '—'],
        ['Automatic sync', 'No'],
        ['Push token', 'Configured'],
      ]
        .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`)
        .join('')}</div>
      <div class="card" style="padding:14px 18px"><div class="cardh" style="margin-bottom:8px">Identity</div>${[
        ['Code', 'MCT-02'],
        ['Branch', 'Muscat HQ'],
        ['Provider', 'ZKTeco PUSH / ADMS protocol'],
        ['Serial number', 'CQZ7234500183'],
        ['Timezone', 'Asia/Muscat'],
      ]
        .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`)
        .join('')}</div>
    </div>`;
  const testCard = `<div class="float card" data-at="b2+5.4" data-anim="up" style="left:1300px;top:830px;width:520px;padding:14px 16px;box-shadow:0 24px 48px -12px rgba(16,24,40,.35)">
      <div class="row" style="justify-content:space-between"><div><div class="vendor">Cloud &amp; server providers</div><b style="font-size:15px">Suprema BioStar 2 API · Connection test</b></div></div>
      <div class="row" style="margin-top:12px">${btn('Test connection', { cls: 'ghost sm', icon: 'LuPlug' })}<span class="hint">Uses the settings entered above; secrets are never stored by the test.</span></div>
      <div class="ok-box" data-at="b2+6.6" data-anim="pop" style="margin-top:12px">${ic('LuCircleCheck')}Connection succeeded <span class="pill-s" style="margin-left:auto">142 ms</span></div></div>`;
  return scene(
    'devices',
    side({
      n: 1,
      kicker: 'Configure devices',
      title: 'Connect your <em>terminals</em>',
      points: [
        ['b0+3.0', 'LuFingerprint', '<b>ZKTeco, Hikvision, Suprema,</b> Anviz and Matrix'],
        ['b1+0.3', 'LuMapPin', 'Code, name, <b>branch</b> and timezone'],
        ['b2+0.4', 'LuKeyRound', 'Push terminals: <b>URL and token</b>, online at first heartbeat'],
        ['b2+5.3', 'LuPlugZap', '<b>Test</b> cloud and server connections'],
      ],
    }) +
      shell({
        active: 'dev',
        url: '/devices',
        content: devicesList('20 devices', cardsBefore),
        attrs: 'data-out="b0+2.4"',
      }) +
      shell({
        active: 'dev',
        url: '/devices/new',
        content: wizard,
        overlay: creds,
        attrs: 'data-at="b0+2.3" data-out="b2+5.9" data-anim="fade"',
      }) +
      shell({
        active: 'dev',
        url: '/devices/5b7f2c9e',
        content: detailPage,
        attrs: 'data-at="b2+5.7" data-out="b2+6.6" data-anim="fade"',
      }) +
      shell({
        active: 'dev',
        url: '/devices',
        content: devicesList('21 devices', cardsAfter, newRow),
        attrs: 'data-at="b2+6.5" data-anim="fade"',
      }) +
      testCard +
      toast('b2+3.5', 'b2+5.8', 'Reception registered', '').replace(
        'class="toast"',
        'class="toast float" style="right:96px;bottom:110px"',
      ) +
      CURSOR(
        'b0+0.6:900,760|b0+1.9:#d-reg|b0+7.4:.p-zk|b0+8.8:#d-next1|b1+0.4:#d-code|b1+3.2:#d-next2|b2+2.2:#d-next3|b2+3.0:#d-save|b2+5.5:#d-close|b2+6.3:#d-crumb',
        'b0+1.9|b0+7.4|b0+8.8|b1+3.2|b2+2.2|b2+3.0|b2+5.5|b2+6.3',
        'b2+6.7',
      ),
  );
};

// ---------------------------------------------------------------- 2. Branches
export const branches = () => {
  const rows = [
    ['MCT', 'Muscat HQ', 'مسقط', 'Muscat', 'Asia/Muscat', 214, null],
    ['SOH', 'Sohar', 'صحار', 'Sohar', 'Asia/Muscat', 96, null],
    ['SLL', 'Salalah', 'صلالة', 'Salalah', 'Asia/Muscat', 71, null],
    ['SUR', 'Sur', 'صور', 'Sur', 'Asia/Muscat', 48, null],
    ['RUH', 'Riyadh', 'الرياض', 'Riyadh', 'Asia/Riyadh', 39, null],
  ];
  const offCell = (d) =>
    d
      ? d.map((x) => `<span class="pill-s">${x}</span>`).join(' ')
      : '<span class="muted" style="font-size:13px">Organisation default</span>';
  const tr = (r, extra = '') =>
    `<tr ${extra}><td><span class="mono" style="font-weight:600;color:#101828">${r[0]}</span></td><td class="strong">${r[1]}<small style="display:block;font-weight:450;color:#667085;font-family:'DejaVu Sans'">${r[2]}</small></td><td>${r[3]}</td><td class="mono" style="font-size:13px">${r[4]}</td><td class="tnum">${r[5]}</td><td>${offCell(r[6])}</td><td>${chip('Active')}</td></tr>`;
  const content = `
    <div class="ph"><div><h2>Organisation structure</h2><p>Branches, departments, designations and teams. Archived rows stay for history and can be reactivated.</p></div></div>
    <div class="tabs"><span class="on">Branches</span><span>Departments</span><span>Designations</span><span>Teams</span></div>
    <div class="row" style="margin-bottom:12px"><div class="inp" style="width:220px;height:36px"><span class="ph-t">Search…</span></div><div class="inp sel" style="width:160px;height:36px"><span>All statuses</span></div><span style="margin-left:auto">${btn('Add branch', { id: 'b-add', icon: 'LuPlus' })}</span></div>
    <div class="card"><table class="tbl" style="font-size:14px"><tr><th>Code</th><th>Name</th><th>City</th><th>Timezone</th><th>Employees</th><th>Weekly off days</th><th>Status</th></tr>
      ${rows.map((r) => tr(r)).join('')}${tr(['NZW', 'Nizwa', 'نزوى', 'Nizwa', 'Asia/Muscat', 0, ['Fri', 'Sat']], 'data-at="b2+0.2" data-hl="b2+0.3~b2+1.6" style="background:#f6fdf9"')}</table></div>`;
  const overlay = modal(
    'b0+1.5',
    'b2',
    'left:70px;top:40px;width:806px',
    `
    ${mhead('Add branch', 'Devices and employees are attached to a branch; its timezone drives attendance dates.')}
    <div class="grid2" style="row-gap:12px">
      ${F('Code', I('NZW', { type: 'b0+2.0', cls: 'mono', focus: 'b0+1.9~b0+2.4' }), { req: 1 })}
      ${F('Name', I('Nizwa', { type: 'b0+2.5', focus: 'b0+2.4~b0+3.0' }), { req: 1 })}
      ${F('Name (Arabic)', I('<span style="font-family:DejaVu Sans">نزوى</span>'), { opt: 1 })}
      ${F('City', I('Nizwa', { type: 'b0+3.1' }), { opt: 1 })}
      ${F('Country', I('OM', { cls: 'mono' }), { req: 1, hint: 'ISO 3166-1 alpha-2, e.g. OM, AE, SA' })}
      ${F('Timezone', I('Asia/Muscat', { sel: 1, cls: 'mono', id: 'b-tz' }), { req: 1, hl: 'b0+3.6~b1+4.6' })}
    </div>
    <div style="font-size:13px;font-weight:700;color:#475467;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 8px">Calendar</div>
    <div class="opt-block" data-hl="b0+4.0~b0+4.9"><div class="oh"><div>Use organisation weekly off days<div class="hint" style="font-weight:450">Turn off to set branch-specific off days.</div></div>${sw(true).replace('class="sw on"', 'class="sw on" data-cls="b0+4.2:off-x"')}</div>
      <div class="days" style="margin-top:10px" data-at="b0+4.3"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span class="on">Fri</span><span class="on">Sat</span></div></div>
    <div style="margin-top:12px">${F('Holiday calendar', I('Oman public holidays 2026', { sel: 1, icon: 'LuCalendarDays' }), { opt: 1, hl: 'b0+5.2~b1' })}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Create', { id: 'b-save' })}</div>`,
  );
  const tzCard = `<div class="float card" data-at="b1+0.3" data-out="b2+0.2" style="left:1240px;top:640px;width:560px;padding:18px 20px;box-shadow:0 20px 40px -10px rgba(16,24,40,.3)">
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
  const geo = `<div class="float card" data-at="b2+1.1" data-anim="up" style="left:1130px;top:420px;width:700px;padding:18px 20px;box-shadow:0 24px 48px -12px rgba(16,24,40,.35)">
      <div class="row" style="justify-content:space-between"><div><h3 style="font-size:18px">New geofence</h3><div class="hint">A circle around the site (and, optionally, a polygon for its exact outline).</div></div>${chip('Attendance → Geofences', 'gray', 'class="nodot"')}</div>
      <div class="grid2" style="margin-top:12px;gap:10px">${F('Name', I('Nizwa branch'), { req: 1 })}${F('Site', I('Nizwa', { sel: 1 }))}</div>
      <div class="grid3" style="margin-top:10px;gap:10px">${F('Latitude', I('22.9333', { cls: 'mono' }), { req: 1 })}${F('Longitude', I('57.5310', { cls: 'mono' }), { req: 1 })}${F('Radius (m)', I('150'), { req: 1 })}</div>
      <div class="grid2" style="margin-top:10px;gap:10px" data-hl="b2+1.4~end">${F('Outside the zone', I('Record and flag', { sel: 1 }), { hint: 'A punch from outside is recorded with the OUTSIDE_GEOFENCE flag for review.' })}${F('Minimum GPS accuracy (m)', I('100'))}</div></div>`;
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
        ['b2+0.5', 'LuMapPinned', '<b>Geofences</b> check web and mobile check-ins'],
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
    ['E-1001', 'Fatma Al Rawahi', 'Muscat HQ', 'Finance', 'Finance manager'],
    ['E-1017', 'Khalid Al Amri', 'Muscat HQ', 'Warehouse', 'Store keeper'],
    ['E-1023', 'Salim Al Harthy', 'Muscat HQ', 'Operations', 'Warehouse supervisor'],
    ['E-1031', 'Yousuf Al Hinai', 'Muscat HQ', 'Warehouse', 'Forklift operator'],
    ['E-1038', 'Noor Al Siyabi', 'Salalah', 'Sales', 'Sales executive'],
  ];
  const list = (withNew) => `
    <div class="ph"><div><h2>Employees</h2><p>${withNew ? '469' : '468'} employees</p></div><div class="row">${btn('Export', { cls: 'ghost', icon: 'LuDownload' })}${btn('Import', { cls: 'ghost', icon: 'LuFileUp', id: withNew ? 'p-imp' : '' })}${btn('Add employee', { icon: 'LuPlus', id: withNew ? '' : 'p-add' })}</div></div>
    <div class="card"><table class="tbl"><tr><th>Employee number</th><th>Name</th><th>Branch</th><th>Department</th><th>Designation</th><th>Status</th></tr>
      ${withNew ? `<tr style="background:#f6fdf9"><td class="mono">E-1042</td><td>${who('Maryam Al Kindi', '', 4)}</td><td>Muscat HQ</td><td>Finance</td><td>Accountant</td><td>${chip('Active')}</td></tr>` : ''}
      ${emps.map((e, k) => `<tr><td class="mono">${e[0]}</td><td>${who(e[1], '', k)}</td><td>${e[2]}</td><td>${e[3]}</td><td>${e[4]}</td><td>${chip('Active')}</td></tr>`).join('')}</table></div>`;
  const sec = (title, desc, body) =>
    `<div class="card" style="padding:14px 16px;margin-bottom:12px"><div class="cardh">${title}</div><div class="hint">${desc}</div>${body}</div>`;
  const newPage = `<div class="crumb">${ic('LuArrowLeft')} Employees</div><div class="ph" style="margin-bottom:12px"><div><h2>Add employee</h2><p>Create the employee record; device enrolment happens when the record is pushed to devices.</p></div></div>
    ${sec('Basic information', 'Identity and contact details.', `<div class="grid3">${F('Employee number', I('E-1042', { type: 'b0+1.8', cls: 'mono', focus: 'b0+1.7~b0+2.2' }), { req: 1 })}${F('First name', I('Maryam', { type: 'b0+2.2', focus: 'b0+2.1~b0+2.6' }), { req: 1 })}${F('Last name', I('Al Kindi', { type: 'b0+2.6', focus: 'b0+2.5~b0+3.0' }), { req: 1 })}</div>`)}
    ${sec('Employment', 'Where and how the employee works. These fields are effective-dated.', `<div class="grid3" style="row-gap:10px">${F('Joining date', I('01 Oct 2026', { icon: 'LuCalendar' }), { req: 1 })}${F('Branch', I('Muscat HQ', { sel: 1 }), { req: 1, hl: 'b0+2.8~b0+3.3' })}${F('Department', I('Finance', { sel: 1 }), { opt: 1, hl: 'b0+3.3~b0+3.8' })}${F('Designation', I('Accountant', { sel: 1 }), { opt: 1, hl: 'b0+3.8~b0+4.3' })}${F('Manager', I('Fatma Al Rawahi', { sel: 1, icon: 'LuUserRound' }), { opt: 1, hl: 'b0+4.3~b0+5.4' })}${F('Secondary manager', I('None', { sel: 1, ph: 1 }), { opt: 1 })}</div>`)}
    ${sec('Device identity', 'How the employee is recognised on attendance devices.', `<div class="grid3">${F('Device user id', I('Auto-assigned', { ph: 1 }), { opt: 1 })}${F('Card number', I('0004471923', { cls: 'mono' }), { opt: 1 })}${F('Device PIN', I('', { ph: 1 }), { opt: 1 })}</div>`)}
    <div class="row" style="justify-content:flex-end;gap:8px">${btn('Cancel', { cls: 'ghost' })}${btn('Create employee', { id: 'p-create' })}</div>`;
  const importPop = `<div class="float menu" data-at="b0+7.0" data-out="b1" style="right:28px;top:128px;width:330px;padding:14px"><b style="font-size:14px">Import employees</b><div class="hint" style="margin:4px 0 10px">Upload a CSV, review validation results, then confirm. Nothing is written until you confirm.</div><div class="row" style="gap:6px;margin-bottom:10px">${['Template', 'Upload', 'Review', 'Done'].map((s, k) => `<span class="pill-s">${k + 1} ${s}</span>`).join('')}</div><div class="row" style="justify-content:space-between;padding:0"><span class="hint">250 valid rows</span>${btn('Import 250 rows', { cls: 'sm' })}</div></div>`;
  const shiftsTable = `
    <div class="ph"><div><h2>Shifts &amp; schedules</h2><p>Shifts, rotational patterns, who works which shift, and the attendance rule sets that turn punches into results.</p></div></div>
    <div class="tabs"><span class="on">Shifts</span><span>Patterns</span><span>Assignments</span><span>Rule sets</span><span>Roster</span><span>Shift requests</span></div>
    <div class="card"><table class="tbl" style="font-size:14px"><tr><th>Code</th><th>Name</th><th>Type</th><th>Hours</th><th>Breaks</th><th>Punch windows &amp; grace</th></tr>
      ${[
        ['GEN', 'General', '08:00 – 17:00', '1 breaks', '#1f9873'],
        ['MOR', 'Morning', '06:00 – 14:00', '1 breaks', '#2e90fa'],
        ['EVE', 'Evening', '14:00 – 22:00', '1 breaks', '#7a5af8'],
        ['NGT', 'Night', '22:00 – 06:00 +1', '1 breaks', '#0e2b25'],
      ]
        .map(
          ([c, n, h, b, col]) =>
            `<tr><td><span class="row" style="gap:8px"><i style="width:10px;height:10px;border-radius:50%;background:${col};display:inline-block"></i><span class="mono">${c}</span></span></td><td class="strong">${n}</td><td>${tag('Fixed')}</td><td class="tnum">${h}</td><td>${b}</td><td class="mono" style="font-size:13px">−240m / +360m</td></tr>`,
        )
        .join('')}</table></div>`;
  const shiftDlg = modal(
    'b1+0.8',
    'b2',
    'left:60px;top:30px;width:830px',
    `
    ${mhead('Edit shift', 'Times are local to the branch of the employee working the shift. A shift that ends after midnight counts for the day it starts.')}
    <div class="grid3" style="gap:10px">${F('Code', I('NGT', { cls: 'mono' }), { req: 1 })}${F('Name', I('Night'), { req: 1 })}${F('Type', I('Fixed', { sel: 1 }), { req: 1, hl: 'b1+2.2~b1+3.6' })}</div>
    <div class="grid2" style="gap:10px;margin-top:10px">${F('Start time', I('22:00', { icon: 'LuClock' }), { req: 1 })}${F('End time', I('06:00', { icon: 'LuClock' }), { req: 1, hint: 'Earlier than start = ends the next day.', hl: 'b1+6.6~b2' })}</div>
    <div class="opt-block" style="margin-top:10px" data-hl="b1+3.7~b1+4.6"><div class="oh">Breaks ${sw()}</div><div class="hint">Paid breaks count as worked time; unpaid breaks are taken off it.</div>
      <div class="row" style="margin-top:8px;gap:10px"><div class="inp sel" style="width:170px;height:34px"><span>Duration</span></div><div class="inp" style="width:120px;height:34px"><span>30</span><span class="ph-t" style="margin-left:auto">min</span></div><span class="row" style="gap:6px;font-size:13.5px;color:#344054">${sw(false)} Paid</span></div></div>
    <div style="font-size:13px;font-weight:700;color:#475467;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 8px">Punch windows &amp; grace</div>
    <div class="grid2" style="gap:10px">
      <div class="opt-block" data-hl="b1+5.4~b1+6.4"><div class="oh">Custom punch-in window ${sw(false)}</div><div class="hint">Off: punches are accepted from 240 min before the shift (platform default).</div></div>
      <div class="opt-block" data-hl="b1+5.4~b1+6.4"><div class="oh">Custom punch-out window ${sw(false)}</div><div class="hint">Off: punches are accepted until 360 min after the shift (platform default).</div></div>
      <div class="opt-block" data-hl="b1+4.6~b1+5.4"><div class="oh">Custom grace in ${sw()}</div><div class="row" style="justify-content:space-between;margin-top:6px"><span class="hint">Grace in (min)</span><b>10</b></div></div>
      <div class="opt-block" data-hl="b1+4.6~b1+5.4"><div class="oh">Custom grace out ${sw()}</div><div class="row" style="justify-content:space-between;margin-top:6px"><span class="hint">Grace out (min)</span><b>5</b></div></div></div>
    <div class="mfoot" style="margin-top:12px;padding-top:12px">${btn('Cancel', { cls: 'ghost' })}${btn('Save')}</div>`,
  );
  const targets = [
    ['Branch', 'Muscat HQ', '0', 'b2+0.9'],
    ['Department', 'Warehouse', 'b2+0.9', 'b2+1.6'],
    ['Team', 'Stores team', 'b2+1.6', 'b2+2.4'],
    ['Employee', 'Ahmed Al Rashdi', 'b2+2.4', 'end+1'],
  ];
  const stackVals = (i) =>
    `<span style="display:grid">${targets.map(([a, b, from, to]) => `<span style="grid-area:1/1" ${from === '0' ? '' : `data-at="${from}" data-anim="fade" data-d="0.2"`} data-out="${to}">${i === 0 ? a : b}</span>`).join('')}</span>`;
  const assignTable = `
    <div class="ph"><div><h2>Shifts &amp; schedules</h2><p>Shifts, rotational patterns, who works which shift, and the attendance rule sets that turn punches into results.</p></div></div>
    <div class="tabs"><span>Shifts</span><span>Patterns</span><span class="on">Assignments</span><span>Rule sets</span><span>Roster</span><span>Shift requests</span></div>
    <div class="card"><table class="tbl" style="font-size:14px"><tr><th>Target</th><th>Shift / pattern</th><th>Branch</th><th>Effective</th></tr>
      <tr><td class="strong">Organisation <small style="display:block">${tag('Organisation')}</small></td><td>General</td><td>All branches</td><td>01 Jan 2026 → open ${chip('Active')}</td></tr>
      <tr><td class="strong">Warehouse <small style="display:block">${tag('Department')}</small></td><td>Night</td><td>Muscat HQ</td><td>11 Oct 2026 → open ${chip('Active')}</td></tr></table></div>`;
  const assignDlg = modal(
    'b2+0.2',
    'end+1',
    'left:90px;top:150px;width:760px',
    `
    ${mhead('Assign shift', '<span data-hl="b2+3.6~end">The most specific assignment wins: employee › team › department › branch › organisation. Overlapping ranges for the same target are rejected.</span>')}
    <div class="grid2" style="gap:12px">${F('Assign to', `<div class="inp sel">${stackVals(0)}</div>`, { req: 1 })}${F('Target', `<div class="inp sel">${stackVals(1)}</div>`, { req: 1 })}</div>
    <div class="opt-block" style="margin-top:12px"><span class="seg"><span class="on">Single shift</span><span>Rotational pattern</span></span><div style="margin-top:10px">${F('Shift', I('Night', { sel: 1 }), { req: 1 })}</div></div>
    <div class="grid2" style="gap:12px;margin-top:12px">${F('Effective from', I('11 Oct 2026', { icon: 'LuCalendar' }), { req: 1, hint: 'Past dates trigger a recalculation.' })}${F('Effective to (last day)', I('', { icon: 'LuCalendar' }), { opt: 1, hint: 'Included: the assignment still applies on this day. Leave empty for no end.' })}</div>
    <div class="mfoot">${btn('Cancel', { cls: 'ghost' })}${btn('Assign')}</div>`,
  );
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
        content: list(false),
        attrs: 'data-out="b0+1.4"',
      }) +
      shell({
        active: 'emp',
        url: '/employees/new',
        content: newPage,
        attrs: 'data-at="b0+1.3" data-out="b0+6.2" data-anim="fade"',
      }) +
      shell({
        active: 'emp',
        url: '/employees',
        content: list(true),
        overlay: importPop,
        attrs: 'data-at="b0+6.1" data-out="b1" data-anim="fade"',
      }) +
      shell({
        active: 'shifts',
        url: '/shifts',
        content: shiftsTable,
        overlay: shiftDlg,
        attrs: 'data-at="b1" data-out="b2" data-anim="fade"',
      }) +
      shell({
        active: 'shifts',
        url: '/shifts?tab=assignments',
        content: assignTable,
        overlay: assignDlg,
        attrs: 'data-at="b2" data-anim="fade"',
      }) +
      toast('b0+5.9', 'b1', 'Maryam Al Kindi created', '').replace(
        'class="toast"',
        'class="toast float" style="right:96px;bottom:110px"',
      ) +
      CURSOR(
        'b0+0.5:760,820|b0+1.1:#p-add|b0+5.6:#p-create|b0+6.9:#p-imp',
        'b0+1.1|b0+5.6|b0+6.9',
        'b1',
      ),
  );
};
