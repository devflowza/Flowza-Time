// FlowZa Time · portal videos · the deck: the plan in detail per portal, with the five recordings embedded (poster frame from
// each MP4). Usage: node deck.mjs <out.pptx> <folder with the MP4s>   (run from a folder whose node_modules has pptxgenjs,
// sharp, react, react-dom and react-icons — make.sh links the tools folder).
import pptxgen from 'pptxgenjs';
import sharp from 'sharp';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Lu from 'react-icons/lu';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const [OUT = 'FlowZa-Time-Portals.pptx', MEDIA = process.cwd()] = process.argv.slice(2);
const INK = '0B2D25'; const DARK = '0E2B25'; const GREEN = '0F6E56'; const MINT = '5DD39E'; const SOFT = 'EEFAF5'; const MUTED = '5B6B66';
const BLUE = '2563EB'; const AMBER = 'D97706'; const RED = 'DC2626'; const VIOLET = '7C3AED';

const png = async (svg, size = 256) => 'image/png;base64,' + (await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()).toString('base64');
const icon = (name, color) => png(renderToStaticMarkup(React.createElement(Lu[name], { color: '#' + color, size: 256 })));
const LOGO = await png('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f6e56"/><path d="M9 9h14v3.2H12.6v3.6h8.8V19h-8.8v5H9z" fill="#fff"/><circle cx="24" cy="22" r="4" fill="#5dd39e"/></svg>', 512);

const VIDEOS = {
  employee: { file: 'FlowZa-Time-1-Employee-Portal.mp4', title: 'Employee portal' },
  manager: { file: 'FlowZa-Time-2-Manager-Portal.mp4', title: 'Manager portal' },
  hr: { file: 'FlowZa-Time-3-HR.mp4', title: 'HR portal' },
  admin: { file: 'FlowZa-Time-4-Admin.mp4', title: 'Admin console' },
  timeaway: { file: 'FlowZa-Time-5-Between-Check-In-And-Out.mp4', title: 'Between check-in and check-out' },
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowza-deck-'));
function videoInfo(key) {
  const file = path.join(MEDIA, VIDEOS[key].file);
  if (!fs.existsSync(file)) return null;
  const poster = path.join(tmp, `${key}.png`);
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
  // the poster: a frame of the app about a third in (past the title card and the sign-in)
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', (seconds * 0.33).toFixed(1), '-i', file, '-frames:v', '1', '-vf', 'scale=1440:-2', poster]);
  return { file, poster: 'image/png;base64,' + fs.readFileSync(poster).toString('base64'), seconds };
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 in
pres.title = 'FlowZa Time — portals, time away and meeting rooms';
pres.subject = 'Video walkthroughs per audience and the delivery plan';
pres.author = 'FlowZa';
pres.company = 'FlowZa';
pres.theme = { headFontFace: 'Arial', bodyFontFace: 'Calibri' };

pres.defineSlideMaster({ title: 'DARK', background: { color: DARK }, objects: [{ image: { data: LOGO, x: 0.8, y: 0.7, w: 0.6, h: 0.6 } }, { text: { text: 'FlowZa Time', options: { x: 1.55, y: 0.72, w: 4, h: 0.55, fontSize: 20, bold: true, color: 'FFFFFF', margin: 0 } } }] });
pres.defineSlideMaster({
  title: 'CONTENT', background: { color: 'FFFFFF' },
  objects: [
    { rect: { x: 0, y: 0, w: 13.333, h: 0.12, fill: { color: GREEN } } },
    { text: { text: 'FlowZa Time · portals, time away and meeting rooms', options: { x: 0.6, y: 7.02, w: 7, h: 0.3, fontSize: 10, color: '8A9A95', margin: 0 } } },
  ],
  slideNumber: { x: 12.3, y: 7.02, w: 0.45, h: 0.3, fontSize: 10, color: '8A9A95', align: 'right' },
});

const title = (s, text, sub) => {
  s.addText(text, { x: 0.6, y: 0.35, w: 12.1, h: 0.7, fontSize: 30, bold: true, color: INK, margin: 0, fontFace: 'Arial' });
  if (sub) s.addText(sub, { x: 0.6, y: 1.02, w: 12.1, h: 0.45, fontSize: 15, color: MUTED, margin: 0 });
};
const bullets = (s, items, box, o = {}) => s.addText(items.map((t) => ({ text: t, options: { bullet: { code: '25CF' }, paraSpaceAfter: o.gap ?? 6 } })), { ...box, fontSize: o.size ?? 15, color: o.color ?? '23332E', valign: 'top', margin: 0.05 });
async function chip(s, x, y, w, ic, color, head, body) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h: 1.55, fill: { color: 'F7FBF9' }, line: { color: 'D7E7E0', width: 1 }, rectRadius: 0.12 });
  s.addImage({ data: await icon(ic, color), x: x + 0.22, y: y + 0.22, w: 0.42, h: 0.42 });
  s.addText(head, { x: x + 0.78, y: y + 0.16, w: w - 0.95, h: 0.5, fontSize: 15, bold: true, color: INK, margin: 0, valign: 'middle' });
  s.addText(body, { x: x + 0.22, y: y + 0.74, w: w - 0.4, h: 0.75, fontSize: 11.5, color: MUTED, margin: 0, valign: 'top' });
}
const table = (s, rows, box, widths, o = {}) => s.addTable(rows.map((r, i) => r.map((c) => ({ text: String(c), options: i === 0 ? { bold: true, color: 'FFFFFF', fill: { color: GREEN } } : { color: '23332E', fill: { color: i % 2 ? 'FFFFFF' : 'F4FAF7' } } }))),
  { ...box, colW: widths, fontSize: o.size ?? 11.5, border: { type: 'solid', pt: 0.5, color: 'D7E7E0' }, valign: 'middle', margin: 0.06, autoPage: false });

/** A video slide: the recording on the left, what it shows on the right. */
function videoSlide(key, sub, points, who) {
  const s = pres.addSlide({ masterName: 'CONTENT' });
  const v = videoInfo(key);
  title(s, `${VIDEOS[key].title} — video`, sub);
  const box = { x: 0.6, y: 1.6, w: 8.0, h: 5.0 };
  if (v) {
    s.addMedia({ type: 'video', path: v.file, cover: v.poster, ...box });
    s.addText(`▶ ${mmss(v.seconds)} · narrated, captions burned in · ${VIDEOS[key].file}`, { x: 0.6, y: 6.65, w: 8, h: 0.3, fontSize: 10, color: '8A9A95', margin: 0 });
  } else {
    s.addShape(pres.ShapeType.rect, { ...box, fill: { color: SOFT }, line: { color: 'D7E7E0' } });
    s.addText(`${VIDEOS[key].file}\n(not rendered yet)`, { ...box, align: 'center', fontSize: 16, color: MUTED });
  }
  s.addText('What it shows', { x: 8.95, y: 1.6, w: 3.8, h: 0.4, fontSize: 16, bold: true, color: GREEN, margin: 0 });
  bullets(s, points, { x: 8.95, y: 2.05, w: 3.85, h: 4.0 }, { size: 13, gap: 5 });
  s.addText(who, { x: 8.95, y: 6.1, w: 3.85, h: 0.5, fontSize: 11.5, italic: true, color: MUTED, margin: 0 });
  return s;
}

// 1 · title ------------------------------------------------------------------------------------------------------------------
{
  const s = pres.addSlide({ masterName: 'DARK' });
  s.addText('Portals, time away and meeting rooms', { x: 0.8, y: 2.2, w: 11.8, h: 1.1, fontSize: 44, bold: true, color: 'FFFFFF', margin: 0 });
  s.addText('Five narrated walkthroughs of the running product — employee, manager, HR, admin, and what happens between check-in and check-out — with the plan in detail and its status.', { x: 0.8, y: 3.35, w: 11.2, h: 1.0, fontSize: 18, color: 'B9D3CA', margin: 0 });
  s.addText('Demo organisation: Al Bahja Trading (Oman) · recorded 15 October 2026', { x: 0.8, y: 6.55, w: 10, h: 0.35, fontSize: 13, color: MINT, bold: true, margin: 0 });
}

// 2 · agenda -----------------------------------------------------------------------------------------------------------------
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'Agenda', 'One short video per audience, each followed by the plan in detail');
  const items = [['LuUser', 'Employee portal', 'Attendance, bar graph, step out, leave, swap'], ['LuUsers', 'Manager portal', 'Team today, approvals, hierarchy'], ['LuBuilding2', 'HR portal', 'Organisation, holidays, leave, reports'],
    ['LuSettings', 'Admin console', 'Settings, roles, terminals, audit'], ['LuTimer', 'Between check-in and check-out', 'Time away, terminals, meeting rooms'], ['LuListChecks', 'Plan, status and rollout', 'What is delivered, what is next']];
  let i = 0;
  for (const [ic, head, body] of items) { await chip(s, 0.6 + (i % 3) * 4.1, 1.75 + Math.floor(i / 3) * 2.0, 3.85, ic, GREEN, head, body); i += 1; }
}

// 3 · delivered --------------------------------------------------------------------------------------------------------------
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'What was built and is live in the product', 'Everything in the videos is the real application on real data — no mock-ups');
  const items = [
    ['LuTimer', BLUE, 'Time away during working hours', 'Engine 1.5.0 classifies every gap between the first IN and the last OUT: official duty, permission, break, unapproved.'],
    ['LuDoorOpen', GREEN, 'Step out / I’m back', 'For sites with an entry terminal only: the portal records the step-out, the terminal (or “I’m back”) the return.'],
    ['LuFingerprint', AMBER, 'Terminal punch roles', 'Entry-only, exit-only, two-way IN/OUT, and ACCESS readers that never touch attendance.'],
    ['LuPresentation', VIOLET, 'Meeting rooms & access', 'Rooms on the location tree, meetings with invitees, attendance from readers, unauthorised entries.'],
    ['LuNetwork', GREEN, 'Managers of managers', 'Team scope “whole hierarchy”: up to five levels, enforced in the database (RLS) and the API alike.'],
    ['LuChartBar', RED, 'Reports and approvals', 'HR time-away report, the activity bar graph, TIME_AWAY approvals, and the managers’ daily morning roll call.'],
  ];
  let i = 0;
  for (const [ic, c, head, body] of items) { await chip(s, 0.6 + (i % 3) * 4.1, 1.7 + Math.floor(i / 3) * 2.05, 3.85, ic, c, head, body); i += 1; }
}

// 4–5 · employee -------------------------------------------------------------------------------------------------------------
videoSlide('employee', 'Ahmed, Technician · Quality Assurance · Office 08:00–14:00', [
  'My overview: today’s shift, check-in on the entrance terminal, the month at a glance',
  'My attendance: month calendar, open a day for punches and the calculation',
  'Activity bar graph: on site vs time away (official, permission, unapproved)',
  'Step out (official / personal, expected return) and I’m back',
  'Plan time away; the monthly permission allowance',
  'Leave balances and Apply for leave',
  'Shift swap request with a colleague',
], 'Audience: every employee · web and phone');
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'Employee portal — plan in detail', 'What the employee can do, how it works, and the rule behind it');
  table(s, [
    ['Feature', 'How it works', 'Rule / control'],
    ['See attendance', 'Calendar, daily log, statistics; open a day for punches and the calculation trace', 'Own records only (RLS self predicate)'],
    ['Bar graph (in site / out site)', 'Activity tab: per day on site, official duty, permission, break, unapproved', 'Engine figures, same as payroll'],
    ['Step out / I’m back', 'Break-out punch now + a request for the expected window; return on the terminal or “I’m back”', 'Policy: step-out allowed, return by terminal only or also portal'],
    ['Plan time away', 'Official duty or personal permission, a window on one day', 'Personal: 4 h a month, 2 h at a time; no overlaps'],
    ['Apply for leave', 'Type, dates, half day; balance shown before sending', 'Allowance, notice and approval workflow per type'],
    ['Shift swap', 'Pick a day and an eligible colleague', 'Line manager approves; both schedules change that day only'],
  ], { x: 0.6, y: 1.6, w: 12.1, h: 4.6 }, [2.6, 5.6, 3.9]);
}

// 6–7 · manager --------------------------------------------------------------------------------------------------------------
videoSlide('manager', 'Nasser, IT & QA team lead — and Hamed, Head of Technology, above him', [
  'Team › Today: who checked in, late, absent, on leave, in now',
  'Morning roll call: yesterday’s Daily Report every working morning',
  'Approvals inbox: time away, leave and shift swaps in one place',
  'Time-away context: window, kind, destination, monthly allowance',
  'Approve → the day is recalculated immediately',
  'Team › Attendance: the month grid for the whole team',
  'Managers of managers: indirect reports “via” their manager',
], 'Audience: line managers, heads of department');
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'Manager portal — plan in detail', 'The daily roll call, one inbox, and the reporting hierarchy');
  table(s, [
    ['Need', 'Where', 'How it works'],
    ['Who logged in, who is absent — daily', 'Team › Today (refreshes every minute) and Dashboard', 'Live from punches and the engine: present, late, absent, on leave, missing punch, in now'],
    ['Approve time away', 'Approvals', 'Line manager (secondary stands in) or an HR workflow up to 5 levels; approval recalculates the day'],
    ['Approve leave and shift swaps', 'Approvals', 'Balance shown; one by one, in bulk, or from the e-mail'],
    ['The month for the team', 'Team › Attendance', 'Month grid per report; open any day'],
    ['Managers of managers', 'Settings › Attendance › Manager team scope', '“Whole reporting hierarchy”: depth 5, enforced by RLS and the API alike; indirect reports labelled'],
    ['Who logged in, who is absent — every morning by e-mail', 'Reports › Schedules (HR sets it up)', '“Morning roll call”: the Daily Report every working morning (Sun–Thu 07:30) for yesterday — each manager receives their own team only'],
  ], { x: 0.6, y: 1.6, w: 12.1, h: 4.6 }, [2.9, 3.4, 5.8]);
}

// 8–9 · HR -------------------------------------------------------------------------------------------------------------------
videoSlide('hr', 'Fatma, HR Manager — the whole organisation', [
  'Dashboard: today across branches, trend, late, on leave',
  'Attendance › Daily by department; open a day',
  'Time away report: month totals per person, flagged days',
  'Schedules the managers’ morning roll call (daily, Sun–Thu)',
  'Organisation: branches, departments, org chart',
  'Holidays: add and remove; days are recalculated',
  'Leave records and balances',
  'Meeting attendance from the room readers',
], 'Audience: HR and attendance administrators');
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'HR portal — plan in detail', 'Overall view, departments, holidays, leave and time away');
  table(s, [
    ['Area', 'What HR does', 'Effect'],
    ['Overview', 'Dashboard by branch; Overview / Operations / Executive layouts', 'One look at the day and the trend'],
    ['Departments & hierarchy', 'Organisation › departments (parent, manager); org chart with drag-and-drop', 'Reporting lines drive approvals and the team scope'],
    ['Holidays', 'Calendars per branch; add, edit, remove holidays (half days, company days)', 'Affected days recalculated; never counted absent'],
    ['Leave', 'Types, allowances, accrual, approvals, team calendar, balances', 'Leave days never marked absent'],
    ['Time away', 'Monthly report per person; policy per group / department / shift', 'Unapproved time deducted and flagged; official duty paid'],
    ['Meetings', 'Rooms, meetings, attendance, access log', 'Who attended, late, absent, unauthorised walk-ins'],
    ['Morning roll call', 'Reports › Schedules: the Daily Report, daily Sun–Thu 07:30, to the managers', 'Each manager receives their own team; a Sunday run covers Thu–Sat'],
  ], { x: 0.6, y: 1.55, w: 12.1, h: 5.0 }, [2.4, 5.6, 4.1], { size: 11 });
}

// 10–11 · admin --------------------------------------------------------------------------------------------------------------
videoSlide('admin', 'Khalid, General Manager — owner of the account', [
  'Settings: regional, attendance, self-service, notifications, security',
  'Manager team scope: direct reports or the whole hierarchy',
  'Users & roles: permissions, branch scope',
  'Devices: entry-only, exit-only, IN/OUT and meeting-room readers',
  'Register a terminal with its punch role',
  'Locations: branches › floors › rooms',
  'Audit log of every change and request',
], 'Audience: owners, administrators, IT');
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'Admin console — plan in detail', 'Configuration that the other three portals depend on');
  table(s, [
    ['Setting', 'Where', 'Recommended for this rollout'],
    ['Attendance policy with time away', 'Attendance › Policies (or Shifts › Rules)', 'Directional punches; official counts as worked; permission 240 min/month, 120 at a time; flag after 15 min'],
    ['Self-service', 'Settings › Attendance', 'Web and mobile check-in on; step-out from the portal on; return by terminal or portal'],
    ['Terminal punch roles', 'Devices › device › Settings', 'Entrance = entry only; exit gate = exit only; lobby = IN/OUT; rooms = ACCESS'],
    ['Meeting rooms', 'Organisation › Locations, then Meetings › Rooms', 'Room = a place with its reader; restrict boardrooms to departments'],
    ['Manager team scope', 'Settings › Attendance', '“Whole reporting hierarchy” for heads of department'],
    ['Roles', 'Users & roles', 'meeting.view / .manage / .rooms as needed; managers who receive the roll call need report.export (e.g. a “Line manager” role = Manager + report.export)'],
  ], { x: 0.6, y: 1.6, w: 12.1, h: 4.7 }, [2.7, 3.4, 6.0]);
}

// 12–14 · between check-in and check-out -------------------------------------------------------------------------------------
videoSlide('timeaway', 'The main concern: time away from the site during working hours', [
  'Two site layouts: two-way terminals, or entry terminal + portal',
  'Terminal roles; room readers never split the day',
  'The policy: official, permission quota, unapproved flag',
  'Classification of every gap, shown in the day’s calculation',
  'The bar graph for employee and manager',
  'Meeting attendance and unauthorised entries',
  'HR month totals',
], 'Audience: everyone — the rules in two minutes');
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'How every gap between check-in and check-out is classified', 'Example: office 08:00–14:00 — IN 08:00, OUT 10:00, IN 12:05, OUT 14:00');
  table(s, [
    ['Kind', 'When', 'Pay / status', 'Example result'],
    ['Official duty', 'Inside an approved OFFICIAL window (+10 min grace)', 'Worked (configurable)', 'Approved 10:00–12:00 → 125 min official; worked 6 h; PRESENT'],
    ['Permission', 'Inside an approved PERSONAL window (+ grace)', 'Unpaid, excused; 4 h a month', 'Approved 10:00–12:00 → 2 h permission; worked 4 h; not short'],
    ['Break', 'The rest, up to the shift’s break allowance', 'As the shift’s break', '30-min lunch allowance used first'],
    ['Unapproved', 'Whatever is left', 'Deducted; UNAPPROVED_AWAY after 15 min', 'No approval → 125 min unapproved; worked 3 h 55; flagged'],
    ['Short gap', 'Under 5 minutes', 'Worked', '3-minute step outside the reader'],
  ], { x: 0.6, y: 1.6, w: 12.1, h: 3.4 }, [1.8, 3.6, 2.9, 3.8]);
  s.addText('Two layouts, same answer', { x: 0.6, y: 5.25, w: 6, h: 0.35, fontSize: 15, bold: true, color: GREEN, margin: 0 });
  bullets(s, ['Two-way terminals: OUT when leaving, IN when returning (IN/OUT keys, or exit + entry gates)', 'Entry terminal only: Step out in the portal; the return is the next check-in, or “I’m back” if the policy allows', 'Requires paired or directional punch interpretation (first/last ignores the middle — refused by the API)'], { x: 0.6, y: 5.6, w: 12.1, h: 1.3 }, { size: 13 });
}
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'What comparable products do — and what FlowZa took', 'Researched practice for attendance terminals and GCC HR suites');
  table(s, [
    ['Product family', 'Mechanism', 'Taken over in FlowZa'],
    ['ZKTeco (push / BioTime), Hikvision', 'Punch states: check-in/out, break-out/in, OT-in/out', 'Break-out / break-in punches; portal step-out writes a break-out'],
    ['Matrix COSEC', '“Official work” and “Short leave” in/out functions', 'Two kinds: OFFICIAL (worked) and PERSONAL (limited)'],
    ['GCC HR suites (Bayzat, Jisr, ZenHR, Menaitech)', 'Permission (استئذان) requests in hours, manager approval, monthly quota', 'Time-away requests via approvals; quota and longest window'],
    ['greytHR, Keka, Zoho People', '“On duty” requests for work outside the office', 'Official duty counts as worked time'],
    ['Suprema, Hikvision, Gallagher access control', 'Door readers by zone; attendance from designated readers only', 'Terminal punch roles; ACCESS readers → room entries, meeting attendance'],
  ], { x: 0.6, y: 1.6, w: 12.1, h: 4.4 }, [3.4, 4.3, 4.4]);
}

// 15 · meeting rooms -----------------------------------------------------------------------------------------------------------
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'Meeting rooms and access control', 'If the meeting rooms have readers: how many attended, when, and who should not have entered');
  bullets(s, [
    'A meeting room is a place in the location tree (HQ › Floor 3 › Boardroom) with a capacity; its readers are ACCESS terminals',
    'Book a meeting: room, time, invitees (required / optional); one meeting per room at a time; capacity checked',
    'Attendance from the room entries: on time, late (minutes after the start), absent; repeat entries counted',
    'Restricted rooms: allowed departments / employees; anyone else entering — or an unknown card — is reported as unauthorised',
    'Room entries never touch attendance: a meeting never splits the working day',
    'Access log for the room administrators (permission meeting.rooms); employees see their own invitations',
    'Next: pushing access groups to the controllers (vendor-specific), so the door itself enforces the restriction',
  ], { x: 0.6, y: 1.65, w: 12.1, h: 5 }, { size: 16, gap: 9 });
}

// 16 · plan and status -------------------------------------------------------------------------------------------------------
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'Plan and status', 'Delivered in this change, and the next steps');
  table(s, [
    ['Work item', 'Status', 'Evidence'],
    ['Engine 1.5.0: time-away classification; nothing changes with the policy off', 'Delivered', '18 new engine tests; all 446 existing pass'],
    ['Policy section “time away” (core, every plan); FIRST_LAST refused', 'Delivered', 'API tests; policy editor'],
    ['Requests, step-out / I’m back, approvals (TIME_AWAY), HR list & monthly summary', 'Delivered', '11 API tests; real-data run'],
    ['Terminal punch roles; ACCESS readers → access_events', 'Delivered', 'Worker tests (normaliser, end-to-end day)'],
    ['Meeting rooms, meetings, attendance, access log (Enterprise module)', 'Delivered', '6 API tests + domain tests'],
    ['Manager team scope: whole hierarchy (RLS + API)', 'Delivered', 'API + SQL RLS suites, cross-tenant probes'],
    ['Daily scheduled roll call to managers (daily cadence, previous day, team-scoped)', 'Delivered', 'Domain, contract and web tests; real run'],
    ['Push room access groups to controllers', 'Next', 'Per vendor (ZKTeco, Hikvision, Suprema)'],
    ['Payroll export columns for permission / unapproved minutes', 'Next', 'Figures already on every daily record'],
  ], { x: 0.6, y: 1.55, w: 12.1, h: 5.1 }, [6.6, 1.4, 4.1], { size: 11 });
}

// 17 · rollout --------------------------------------------------------------------------------------------------------------
{
  const s = pres.addSlide({ masterName: 'CONTENT' });
  title(s, 'Rollout for a customer', 'Six steps, about two weeks including a pilot');
  table(s, [
    ['#', 'Step', 'Owner', 'When'],
    ['1', 'Mark each terminal: entry only, exit only, IN/OUT, or meeting-room reader', 'IT / admin', 'Day 1'],
    ['2', 'Create the time-away policy for the pilot group (directional punches, quotas, flags)', 'HR', 'Day 1'],
    ['3', 'Set reporting lines; choose the manager team scope', 'HR / admin', 'Day 2'],
    ['4', 'Places and meeting rooms; restrict boardrooms', 'Facilities', 'Day 2–3'],
    ['5', 'Pilot one department for a week; review the time-away report', 'HR + managers', 'Week 1'],
    ['6', 'Train with these videos; roll out to all departments', 'HR', 'Week 2'],
  ], { x: 0.6, y: 1.6, w: 12.1, h: 4.2 }, [0.6, 7.3, 2.2, 2.0]);
}

// 18 · close -----------------------------------------------------------------------------------------------------------------
{
  const s = pres.addSlide({ masterName: 'DARK' });
  s.addText('Every minute between check-in and check-out, accounted for.', { x: 0.8, y: 2.5, w: 11.8, h: 1.4, fontSize: 40, bold: true, color: 'FFFFFF', margin: 0 });
  s.addText('FlowZa Time — people on time, business on track.', { x: 0.8, y: 4.0, w: 11, h: 0.6, fontSize: 20, color: 'B9D3CA', margin: 0 });
}

await pres.writeFile({ fileName: OUT });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`deck → ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
