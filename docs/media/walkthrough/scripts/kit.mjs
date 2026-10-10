// Shared building blocks for the video scenes and the deck: lucide icons as inline SVG, the app shell, the side panel.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Lu from 'react-icons/lu';

export const ic = (name, extra = '') => {
  const C = Lu[name];
  if (!C) throw new Error('icon ' + name);
  return renderToStaticMarkup(React.createElement(C, { 'aria-hidden': true })).replace(
    '<svg ',
    `<svg ${extra} `,
  );
};

export const LOGO = `<svg class="logo" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f6e56"/><path d="M9 9h14v3.2H12.6v3.6h8.8V19h-8.8v5H9z" fill="#fff"/><circle cx="24" cy="22" r="4" fill="#5dd39e"/></svg>`;
export const CURSOR = (path, clicks = '', hide = '') =>
  `<div class="click-ring"></div><svg class="cursor" viewBox="0 0 30 30" data-path="${path}" data-clicks="${clicks}" ${hide ? `data-hide="${hide}"` : ''}><path d="M5 3 L5 25 L11 19.5 L15 28 L19 26.2 L15 17.8 L23 17.8 Z" fill="#fff" stroke="#101828" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

const NAV = [
  [null, [['dash', 'Dashboard', 'LuLayoutDashboard']]],
  ['My team', [['team', 'Team overview', 'LuContactRound']]],
  [
    'Workforce',
    [
      ['emp', 'Employees', 'LuUsers'],
      ['att', 'Attendance', 'LuActivity'],
      ['appr', 'Approvals', 'LuSquareCheck'],
      ['leave', 'Leave', 'LuCalendarOff'],
      ['dep', 'Branch deployments', 'LuArrowRightLeft'],
    ],
  ],
  [
    'Devices & sync',
    [
      ['dev', 'Devices', 'LuCpu'],
      ['sync', 'Sync jobs', 'LuRefreshCw'],
    ],
  ],
  [
    'Time',
    [
      ['shifts', 'Shifts', 'LuCalendarDays'],
      ['rep', 'Reports', 'LuChartColumn'],
    ],
  ],
  [
    'Administration',
    [
      ['org', 'Organisation', 'LuBuilding2'],
      ['users', 'Users & roles', 'LuShieldCheck'],
      ['set', 'Settings', 'LuSettings'],
    ],
  ],
];
const PORTAL = [
  [
    'My workspace',
    [
      ['my', 'My overview', 'LuHouse'],
      ['myatt', 'My attendance', 'LuCalendarCheck'],
      ['myleave', 'My leave', 'LuTreePalm'],
      ['myreq', 'My requests', 'LuInbox'],
      ['myshift', 'My shift', 'LuCalendarClock'],
      ['checkin', 'Check in / out', 'LuFingerprint'],
    ],
  ],
];

export const ORG = 'Majan Gulf Trading';
export function shell({
  active,
  url,
  content,
  overlay = '',
  badge = 0,
  user = ['Aisha Al Balushi', 'AB'],
  portal = false,
  attrs = '',
  cls = '',
}) {
  const nav = (portal ? PORTAL : NAV)
    .map(
      ([sec, items]) =>
        (sec ? `<div class="sec">${sec}</div>` : '') +
        items
          .map(
            ([k, label, icon]) =>
              `<div class="it ${k === active ? 'on' : ''}" data-nav="${k}">${ic(icon)}<span>${label}</span>${k === 'appr' && badge ? `<span class="badge">${badge}</span>` : ''}</div>`,
          )
          .join(''),
    )
    .join('');
  return `<div class="win ${cls}" ${attrs}><div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
    <div class="url">${ic('LuLock')}<span>time.flowza.com${url}</span></div></div>
    <div class="app"><aside class="nav"><div class="brand">${LOGO}<div>FlowZa Time<small>${ORG}</small></div></div>${nav}</aside>
    <div class="main"><div class="top"><div class="search">${ic('LuSearch')}<span>Search employees, devices…</span></div>
    <div class="org">${ic('LuBell', 'width="18" height="18"')}<span class="av" style="background:${user[2] || '#137a5d'}">${user[1]}</span><span>${user[0]}</span></div></div>
    <div class="page">${content}</div>${overlay}</div></div></div>`;
}

export function side({ n, total = 9, kicker, title, points }) {
  return `<div class="side"><div data-at="0.2"><span class="step"><span class="num">${String(n).padStart(2, '0')}</span>${kicker} <span class="of">· ${n} of ${total}</span></span></div>
    <h1 data-at="0.35">${title}</h1><ul class="pts">${points.map(([at, icon, html]) => `<li data-at="${at}" data-anim="left"><span class="i">${ic(icon)}</span><span>${html}</span></li>`).join('')}</ul></div>`;
}
