import pptxgen from 'pptxgenjs';
import sharp from 'sharp';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Lu from 'react-icons/lu';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// pptxgenjs cannot write theme colours: put THEME's scheme into the theme part it wrote (scheme colours resolve against it).
async function applyTheme(file, theme) {
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('pptxgenjs')] }));
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const part = 'ppt/theme/theme1.xml';
  const slots = [
    'dk1',
    'lt1',
    'dk2',
    'lt2',
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'hlink',
    'folHlink',
  ];
  const scheme =
    `<a:clrScheme name="${theme.name}">` +
    slots.map((k) => `<a:${k}><a:srgbClr val="${theme.colors[k]}"/></a:${k}>`).join('') +
    '</a:clrScheme>';
  const xml = (await zip.file(part).async('string'))
    .replace(/<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/, () => scheme)
    .replace(
      /(<a:(?:theme|fontScheme)\b[^>]*?\bname=")[^"]*"/g,
      (_, head) => `${head}${theme.name}"`,
    );
  if (!xml.includes(scheme)) throw new Error('no colour scheme in ' + part);
  zip.file(part, xml);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

const OUT = process.argv[2] || 'FlowZa-Time-Enterprise.pptx';
const THEME = {
  name: 'FlowZa Green',
  headFontFace: 'Arial',
  bodyFontFace: 'Calibri',
  colors: {
    dk1: '0B2D25',
    lt1: 'FFFFFF',
    dk2: '0E2B25',
    lt2: 'EEFAF5',
    accent1: '0F6E56',
    accent2: '1F9873',
    accent3: '5DD39E',
    accent4: 'F59E0B',
    accent5: '3B82F6',
    accent6: 'EF4444',
    hlink: '0F6E56',
    folHlink: '137A5D',
  },
};
const HEX = THEME.colors;

const png = async (svg, size = 256) =>
  'image/png;base64,' +
  (await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()).toString('base64');
const icon = (name, color) =>
  png(renderToStaticMarkup(React.createElement(Lu[name], { color: '#' + color, size: 256 })));
const LOGO = await png(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f6e56"/><path d="M9 9h14v3.2H12.6v3.6h8.8V19h-8.8v5H9z" fill="#fff"/><circle cx="24" cy="22" r="4" fill="#5dd39e"/></svg>',
  512,
);

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = 'FlowZa Time Enterprise';
pres.subject = 'Product overview';
pres.author = 'FlowZa';
pres.company = 'FlowZa';
const C = pres.SchemeColor;

pres.defineSlideMaster({
  title: 'Title dark',
  background: { color: C.text2 },
  objects: [
    {
      placeholder: {
        options: {
          name: 'title',
          type: 'title',
          x: 0.8,
          y: 2.45,
          w: 11.5,
          h: 1.2,
          fontSize: 48,
          bold: true,
          color: C.background1,
          valign: 'bottom',
          align: 'left',
          margin: 0,
        },
        text: '',
      },
    },
    {
      placeholder: {
        options: {
          name: 'body',
          type: 'body',
          x: 0.8,
          y: 3.75,
          w: 10.5,
          h: 0.9,
          fontSize: 22,
          color: 'B9D3CA',
          valign: 'top',
          align: 'left',
          margin: 0,
        },
        text: '',
      },
    },
    {
      text: {
        text: 'flowza.com',
        options: {
          x: 0.8,
          y: 6.75,
          w: 4,
          h: 0.35,
          fontSize: 14,
          bold: true,
          color: C.accent3,
          margin: 0,
        },
      },
    },
  ],
});
pres.defineSlideMaster({
  title: 'Content',
  background: { color: C.background1 },
  margin: [0.5, 0.6, 0.6, 0.6],
  objects: [
    {
      placeholder: {
        options: {
          name: 'title',
          type: 'title',
          x: 0.6,
          y: 0.4,
          w: 12.1,
          h: 0.8,
          fontSize: 36,
          bold: true,
          color: C.text1,
          valign: 'middle',
          align: 'left',
          margin: 0,
        },
        text: '',
      },
    },
    {
      text: {
        text: 'FlowZa Time Enterprise',
        options: { x: 0.6, y: 6.95, w: 5, h: 0.3, fontSize: 11, color: '667085', margin: 0 },
      },
    },
    {
      text: {
        text: 'flowza.com',
        options: {
          x: 9.2,
          y: 6.95,
          w: 3.0,
          h: 0.3,
          fontSize: 11,
          bold: true,
          color: C.accent1,
          align: 'right',
          margin: 0,
        },
      },
    },
  ],
  slideNumber: { x: 12.35, y: 6.95, w: 0.4, h: 0.3, fontSize: 11, color: '667085', align: 'right' },
});
pres.defineSlideMaster({
  title: 'Closing dark',
  background: { color: C.text2 },
  objects: [
    {
      placeholder: {
        options: {
          name: 'title',
          type: 'title',
          x: 0.6,
          y: 0.4,
          w: 12.1,
          h: 0.8,
          fontSize: 36,
          bold: true,
          color: C.background1,
          valign: 'middle',
          align: 'left',
          margin: 0,
        },
        text: '',
      },
    },
    {
      text: {
        text: 'flowza.com',
        options: {
          x: 9.2,
          y: 6.95,
          w: 3.5,
          h: 0.3,
          fontSize: 11,
          bold: true,
          color: C.accent3,
          align: 'right',
          margin: 0,
        },
      },
    },
  ],
});

const T = (slide, text, o) =>
  slide.addText(text, { isTextBox: true, margin: 0, fontFace: undefined, ...o });
const card = (slide, x, y, w, h, name, fill = C.background2) =>
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x,
    y,
    w,
    h,
    rectRadius: 0.14,
    fill: { color: fill },
    line: { color: fill, width: 0 },
    objectName: name,
  });
const badge = async (slide, x, y, d, iconName, name, bg = C.accent1, fg = 'FFFFFF') => {
  slide.addShape(pres.shapes.OVAL, {
    x,
    y,
    w: d,
    h: d,
    fill: { color: bg },
    line: { color: bg, width: 0 },
    objectName: name + ' circle',
  });
  slide.addImage({
    data: await icon(iconName, fg),
    x: x + d * 0.24,
    y: y + d * 0.24,
    w: d * 0.52,
    h: d * 0.52,
    objectName: name + ' icon',
  });
};
const bullets = (items, o = {}) =>
  items.map((t, i) => ({
    text: t,
    options: { bullet: { indent: 14 }, breakLine: i < items.length - 1, paraSpaceAfter: 7, ...o },
  }));

// ---------------------------------------------------------------- 1. Title
pres.addSection({ title: 'Introduction' });
{
  const s = pres.addSlide({ masterName: 'Title dark', sectionTitle: 'Introduction' });
  s.addImage({ data: LOGO, x: 0.8, y: 0.85, w: 1.15, h: 1.15, objectName: 'FlowZa logo' });
  s.addText('FlowZa Time Enterprise', { placeholder: 'title' });
  s.addText(
    'Cloud attendance and workforce time management for multi-branch organisations across Oman and the GCC',
    { placeholder: 'body' },
  );
  const topics = [
    ['LuCpu', 'Devices'],
    ['LuBuilding2', 'Branches'],
    ['LuUsers', 'Employees & shifts'],
    ['LuCalendarClock', 'Shift changes'],
    ['LuArrowRightLeft', 'Deployments'],
    ['LuTreePalm', 'Leave'],
    ['LuSquareCheck', 'Approvals'],
    ['LuRepeat', 'Shift swaps'],
    ['LuLayoutDashboard', 'Dashboard'],
  ];
  for (let i = 0; i < topics.length; i++) {
    const x = 0.8 + i * 1.32;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x,
      y: 5.15,
      w: 0.62,
      h: 0.62,
      rectRadius: 0.12,
      fill: { color: '17453A' },
      line: { color: '17453A', width: 0 },
      objectName: `Topic ${i + 1} tile`,
    });
    s.addImage({
      data: await icon(topics[i][0], '78CFAF'),
      x: x + 0.15,
      y: 5.3,
      w: 0.32,
      h: 0.32,
      objectName: `Topic ${i + 1} icon`,
    });
    T(s, topics[i][1], {
      x: x - 0.05,
      y: 5.85,
      w: 1.25,
      h: 0.5,
      fontSize: 12,
      color: 'D7E5E0',
      valign: 'top',
      objectName: `Topic ${i + 1} label`,
    });
  }
  s.addNotes(
    'Welcome to FlowZa Time Enterprise: cloud attendance for multi-branch organisations across Oman and the GCC. This overview walks from the first device to the live dashboard. Learn more at flowza.com.',
  );
}

// ---------------------------------------------------------------- 2. Setup
pres.addSection({ title: 'Set up' });
{
  const s = pres.addSlide({ masterName: 'Content', sectionTitle: 'Set up' });
  s.addText('Set up in three steps', { placeholder: 'title' });
  T(s, 'Devices, sites and people: everything else builds on these.', {
    x: 0.6,
    y: 1.2,
    w: 12,
    h: 0.4,
    fontSize: 16,
    color: '475467',
  });
  const cols = [
    [
      'LuCpu',
      '01  Configure devices',
      [
        'Register ZKTeco, Hikvision, Suprema, Anviz or Matrix terminals',
        'Code, name and branch; timezone follows the branch',
        'Test the connection; push terminals get their own URL and token',
        'Punches sync automatically and every sync job is tracked',
      ],
    ],
    [
      'LuBuilding2',
      '02  Branches & sites',
      [
        'Each branch is a site: code, city and timezone',
        'Its own weekly off days and holiday calendar',
        'The branch timezone decides the attendance date',
        'Geofences control where mobile check-in is allowed',
      ],
    ],
    [
      'LuUsers',
      '03  Employees & shifts',
      [
        'Add employees one by one or import from CSV',
        'Branch, department, designation and line manager',
        'Fixed or flexible shifts with breaks, grace and punch windows, including overnight',
        'Assign by branch, department, team or employee; the most specific wins',
      ],
    ],
  ];
  for (let i = 0; i < 3; i++) {
    const x = 0.6 + i * 4.15,
      y = 1.85,
      w = 3.85,
      h = 4.8;
    card(s, x, y, w, h, `Step ${i + 1} card`);
    await badge(s, x + 0.3, y + 0.3, 0.7, cols[i][0], `Step ${i + 1}`);
    T(s, cols[i][1], {
      x: x + 0.3,
      y: y + 1.15,
      w: w - 0.6,
      h: 0.75,
      fontSize: 20,
      bold: true,
      color: C.text1,
      fontFace: 'Arial',
      valign: 'top',
      objectName: `Step ${i + 1} title`,
    });
    T(s, bullets(cols[i][2]), {
      x: x + 0.3,
      y: y + 1.95,
      w: w - 0.55,
      h: 2.7,
      fontSize: 14,
      color: '344054',
      valign: 'top',
      objectName: `Step ${i + 1} points`,
    });
  }
  s.addNotes(
    'Start with your devices: register the terminal, pick the provider, give it a code, a name and a branch, and test the connection. Next, your sites: each branch has a code, a city, a timezone, weekly off days and a holiday calendar; the branch timezone decides the attendance date. Then add your people, or import them from CSV, define fixed or flexible shifts, and assign them. The most specific assignment wins.',
  );
}

// ---------------------------------------------------------------- 3. Workforce changes
pres.addSection({ title: 'Workforce changes' });
{
  const s = pres.addSlide({ masterName: 'Content', sectionTitle: 'Workforce changes' });
  s.addText('Workforce changes, handled without rework', { placeholder: 'title' });
  // Deployment story
  card(s, 0.6, 1.5, 7.55, 5.15, 'Deployment card');
  await badge(s, 0.9, 1.8, 0.62, 'LuArrowRightLeft', 'Deployment');
  T(s, 'Branch deployment', {
    x: 1.7,
    y: 1.78,
    w: 6,
    h: 0.4,
    fontSize: 20,
    bold: true,
    color: C.text1,
    fontFace: 'Arial',
    objectName: 'Deployment title',
  });
  T(s, 'Salim works in Muscat and covers the Sohar branch for two weeks', {
    x: 1.7,
    y: 2.18,
    w: 6.2,
    h: 0.35,
    fontSize: 14,
    color: '475467',
    objectName: 'Deployment subtitle',
  });
  const node = (x, y, w, title, sub, name, fill = C.background1) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x,
      y,
      w,
      h: 0.95,
      rectRadius: 0.1,
      fill: { color: fill },
      line: { color: 'D5F2E5', width: 1 },
      objectName: name,
    });
    T(
      s,
      [
        { text: title, options: { bold: true, fontSize: 16, color: C.text1, breakLine: true } },
        { text: sub, options: { fontSize: 12, color: '475467' } },
      ],
      {
        x: x + 0.2,
        y: y + 0.12,
        w: w - 0.4,
        h: 0.72,
        valign: 'middle',
        objectName: name + ' text',
      },
    );
  };
  node(0.9, 2.85, 2.6, 'Muscat HQ', 'Home branch', 'Home branch node');
  s.addShape(pres.shapes.LINE, {
    x: 3.6,
    y: 3.32,
    w: 1.25,
    h: 0,
    line: { color: C.accent2, width: 2.5, dashType: 'dash', endArrowType: 'triangle' },
    objectName: 'Deployment arrow',
  });
  T(s, '11 – 22 Oct', {
    x: 3.55,
    y: 2.92,
    w: 1.35,
    h: 0.3,
    fontSize: 12,
    bold: true,
    color: C.accent1,
    align: 'center',
    objectName: 'Deployment dates',
  });
  node(4.95, 2.85, 2.9, 'Sohar', 'Covering branch', 'Host branch node');
  const steps = [
    ['LuUserPlus', 'Day one', 'Enrolled on the Sohar terminals'],
    ['LuFingerprint', 'During', 'Punches at Sohar count automatically'],
    ['LuUserMinus', 'After the last day', 'Removed from the Sohar terminals'],
  ];
  for (let i = 0; i < 3; i++) {
    const x = 0.9 + i * 2.38;
    await badge(
      s,
      x,
      4.2,
      0.48,
      steps[i][0],
      `Deployment step ${i + 1}`,
      C.background1,
      HEX.accent1,
    );
    T(
      s,
      [
        {
          text: steps[i][1],
          options: { bold: true, fontSize: 14, color: C.text1, breakLine: true },
        },
        { text: steps[i][2], options: { fontSize: 12, color: '475467' } },
      ],
      { x, y: 4.78, w: 2.2, h: 0.85, valign: 'top', objectName: `Deployment step ${i + 1} text` },
    );
  }
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.9,
    y: 5.75,
    w: 6.95,
    h: 0.6,
    rectRadius: 0.1,
    fill: { color: C.accent1 },
    line: { color: C.accent1, width: 0 },
    objectName: 'Deployment outcome',
  });
  T(s, 'Shift, holidays and payroll stay with Muscat HQ, with no manual fixes', {
    x: 1.1,
    y: 5.75,
    w: 6.6,
    h: 0.6,
    fontSize: 14,
    bold: true,
    color: C.background1,
    valign: 'middle',
    objectName: 'Deployment outcome text',
  });
  // Right column
  const side = [
    [
      'LuCalendarClock',
      'Shift changes',
      [
        'Effective from date and an optional last day',
        'Bulk change for many employees',
        'Employees request changes from their portal',
        'Past days are recalculated automatically',
      ],
    ],
    [
      'LuRepeat',
      'Shift swaps',
      [
        'Employee picks the day and a colleague',
        'The line manager approves in the inbox',
        'Both schedules change for that day only',
      ],
    ],
  ];
  let y = 1.5;
  for (const [ic, title, pts] of side) {
    const h = title === 'Shift changes' ? 2.7 : 2.3;
    card(s, 8.45, y, 4.25, h, `${title} card`);
    await badge(s, 8.7, y + 0.25, 0.5, ic, title);
    T(s, title, {
      x: 9.35,
      y: y + 0.27,
      w: 3.2,
      h: 0.45,
      fontSize: 18,
      bold: true,
      color: C.text1,
      fontFace: 'Arial',
      valign: 'middle',
      objectName: `${title} title`,
    });
    T(s, bullets(pts), {
      x: 8.7,
      y: y + 0.9,
      w: 3.85,
      h: h - 1.0,
      fontSize: 14,
      color: '344054',
      valign: 'top',
      objectName: `${title} points`,
    });
    y += h + 0.15;
  }
  s.addNotes(
    'To change a shift, assign the new one with an effective-from date, and an end date if it is temporary. Change many employees at once, or let employees request a change; past days are recalculated automatically. When Salim, from Muscat, covers Sohar for two weeks, a branch deployment enrols him on the Sohar terminals on day one and removes him after the last day, while his shift, holidays and payroll stay with Muscat. Shift swaps: the employee picks a day and a colleague, the line manager approves, and both schedules change for that day only.',
  );
}

// ---------------------------------------------------------------- 4. Leave & approvals
pres.addSection({ title: 'Leave & approvals' });
{
  const s = pres.addSlide({ masterName: 'Content', sectionTitle: 'Leave & approvals' });
  s.addText('Leave and line-manager approvals', { placeholder: 'title' });
  card(s, 0.6, 1.5, 5.4, 5.15, 'Leave card');
  await badge(s, 0.9, 1.8, 0.62, 'LuTreePalm', 'Leave');
  T(s, 'Leave management', {
    x: 1.7,
    y: 1.83,
    w: 4,
    h: 0.55,
    fontSize: 20,
    bold: true,
    color: C.text1,
    fontFace: 'Arial',
    valign: 'middle',
    objectName: 'Leave title',
  });
  const types = ['Annual', 'Sick', 'Casual', 'Emergency', 'Maternity', 'No pay'];
  types.forEach((t, i) => {
    const x = 0.9 + (i % 3) * 1.62,
      yy = 2.65 + Math.floor(i / 3) * 0.5;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x,
      y: yy,
      w: 1.5,
      h: 0.38,
      rectRadius: 0.19,
      fill: { color: C.background1 },
      line: { color: 'AEE4CD', width: 1 },
      objectName: `Leave type ${t}`,
    });
    T(s, t, {
      x,
      y: yy,
      w: 1.5,
      h: 0.38,
      fontSize: 12,
      bold: true,
      color: C.accent1,
      align: 'center',
      valign: 'middle',
      objectName: `Leave type ${t} label`,
    });
  });
  T(
    s,
    bullets([
      'Yearly days, monthly accrual and carry forward',
      'Employees apply from the portal and see their balance first',
      'Approved leave shows on the team calendar',
      'Those days count as leave, not absence',
    ]),
    {
      x: 0.9,
      y: 3.85,
      w: 4.85,
      h: 2.6,
      fontSize: 14,
      color: '344054',
      valign: 'top',
      objectName: 'Leave points',
    },
  );
  // Approval flow
  T(s, 'Every request goes to the right person', {
    x: 6.4,
    y: 1.5,
    w: 6.3,
    h: 0.45,
    fontSize: 20,
    bold: true,
    color: C.text1,
    fontFace: 'Arial',
    objectName: 'Approvals title',
  });
  const flow = [
    ['LuSend', 'Request', 'Employee submits'],
    ['LuUserRound', 'Level 1', 'Line manager'],
    ['LuShieldCheck', 'Level 2', 'HR admins'],
    ['LuCircleCheck', 'Approved', 'Attendance updates'],
  ];
  for (let i = 0; i < 4; i++) {
    const x = 6.4 + i * 1.6;
    await badge(
      s,
      x + 0.35,
      2.15,
      0.62,
      flow[i][0],
      `Flow ${flow[i][1]}`,
      i === 3 ? C.accent2 : C.accent1,
    );
    T(
      s,
      [
        {
          text: flow[i][1],
          options: { bold: true, fontSize: 14, color: C.text1, breakLine: true },
        },
        { text: flow[i][2], options: { fontSize: 12, color: '475467' } },
      ],
      {
        x,
        y: 2.85,
        w: 1.35,
        h: 0.7,
        align: 'center',
        valign: 'top',
        objectName: `Flow ${flow[i][1]} text`,
      },
    );
    if (i < 3)
      s.addShape(pres.shapes.LINE, {
        x: x + 1.08,
        y: 2.46,
        w: 0.75,
        h: 0,
        line: { color: 'AEE4CD', width: 2, endArrowType: 'triangle' },
        objectName: `Flow arrow ${i + 1}`,
      });
  }
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 7.85,
    y: 3.68,
    w: 3.4,
    h: 0.4,
    rectRadius: 0.2,
    fill: { color: 'FFFAEB' },
    line: { color: 'FEDF89', width: 1 },
    objectName: 'Escalation tag',
  });
  T(s, 'Escalates if nobody acts in time', {
    x: 7.85,
    y: 3.68,
    w: 3.4,
    h: 0.4,
    fontSize: 12,
    bold: true,
    color: 'B54708',
    align: 'center',
    valign: 'middle',
    objectName: 'Escalation text',
  });
  card(s, 6.4, 4.35, 6.3, 2.3, 'Inbox card');
  T(s, 'One Approvals inbox', {
    x: 6.7,
    y: 4.55,
    w: 5.8,
    h: 0.4,
    fontSize: 16,
    bold: true,
    color: C.text1,
    objectName: 'Inbox title',
  });
  const kinds = ['Leave', 'Attendance correction', 'Regularisation', 'Shift change', 'Shift swap'];
  let kx = 6.7,
    ky = 5.05;
  for (const k of kinds) {
    const w = 0.3 + k.length * 0.085;
    if (kx + w > 12.45) {
      kx = 6.7;
      ky += 0.48;
    }
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x: kx,
      y: ky,
      w,
      h: 0.36,
      rectRadius: 0.18,
      fill: { color: C.background1 },
      line: { color: 'D0D5DD', width: 1 },
      objectName: `Inbox type ${k}`,
    });
    T(s, k, {
      x: kx,
      y: ky,
      w,
      h: 0.36,
      fontSize: 12,
      color: '344054',
      align: 'center',
      valign: 'middle',
      objectName: `Inbox type ${k} label`,
    });
    kx += w + 0.12;
  }
  T(
    s,
    'Approve, reject, ask for information or reassign: one by one, in bulk, or from an email. Workflows add up to five levels; a secondary manager is the backup approver.',
    {
      x: 6.7,
      y: 5.95,
      w: 5.8,
      h: 0.6,
      fontSize: 12,
      color: '475467',
      valign: 'top',
      objectName: 'Inbox actions',
    },
  );
  s.addNotes(
    'Leave is built in: annual, sick, emergency or maternity leave, with yearly days, monthly accrual and carry forward. Employees apply from their portal and see their balance first; approved leave appears on the team calendar and counts as leave, not absence. Every request goes to the right person: each employee has a line manager and an optional secondary manager. Leave, corrections, regularisations, shift changes and swaps land in one Approvals inbox. Workflows add up to five levels, with escalation when nobody acts in time.',
  );
}

// ---------------------------------------------------------------- 5. Configure & dashboard
pres.addSection({ title: 'Dashboard' });
{
  const s = pres.addSlide({ masterName: 'Closing dark', sectionTitle: 'Dashboard' });
  s.addText('Configure once, watch it live', { placeholder: 'title' });
  T(s, 'Example dashboard: today at a glance', {
    x: 0.6,
    y: 1.35,
    w: 6,
    h: 0.35,
    fontSize: 14,
    color: 'B9D3CA',
    objectName: 'Stats caption',
  });
  const stats = [
    ['412', 'Present today', '5DD39E'],
    ['14', 'Absent', 'FCA5A5'],
    ['23', 'On leave', '93C5FD'],
    ['19', 'Late', 'FCD34D'],
  ];
  stats.forEach(([v, l, c], i) => {
    const x = 0.6 + (i % 2) * 3.05,
      y = 1.9 + Math.floor(i / 2) * 1.85;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x,
      y,
      w: 2.85,
      h: 1.65,
      rectRadius: 0.14,
      fill: { color: '17453A' },
      line: { color: '17453A', width: 0 },
      objectName: `Stat ${l} card`,
    });
    T(s, v, {
      x: x + 0.3,
      y: y + 0.18,
      w: 2.3,
      h: 0.9,
      fontSize: 54,
      bold: true,
      color: c,
      fontFace: 'Arial',
      valign: 'middle',
      objectName: `Stat ${l} value`,
    });
    T(s, l, {
      x: x + 0.3,
      y: y + 1.08,
      w: 2.3,
      h: 0.4,
      fontSize: 14,
      color: 'D7E5E0',
      objectName: `Stat ${l} label`,
    });
  });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.6,
    y: 5.85,
    w: 5.9,
    h: 0.75,
    rectRadius: 0.14,
    fill: { color: '17453A' },
    line: { color: '17453A', width: 0 },
    objectName: 'Attendance rate card',
  });
  T(
    s,
    [
      { text: '92%  ', options: { bold: true, fontSize: 24, color: '5DD39E' } },
      { text: 'attendance rate, up 2.1% on last week', options: { fontSize: 14, color: 'D7E5E0' } },
    ],
    { x: 0.9, y: 5.85, w: 5.4, h: 0.75, valign: 'middle', objectName: 'Attendance rate text' },
  );
  const pts = [
    [
      'LuSettings',
      'Settings',
      'Regional, attendance rules, sync, notifications, security and leave',
    ],
    ['LuShieldCheck', 'Roles & branch scope', 'Decide who sees and approves for which branch'],
    ['LuPalette', '7 styles, 3 layouts', 'Overview, Operations or Executive'],
    ['LuFileText', 'Reports', 'Daily, monthly, late, absence and leave in PDF, Excel or CSV'],
  ];
  for (let i = 0; i < pts.length; i++) {
    const y = 1.9 + i * 0.92;
    await badge(s, 7.0, y, 0.6, pts[i][0], `Config ${i + 1}`, '17453A', HEX.accent3);
    T(
      s,
      [
        {
          text: pts[i][1],
          options: { bold: true, fontSize: 16, color: C.background1, breakLine: true },
        },
        { text: pts[i][2], options: { fontSize: 14, color: 'B9D3CA' } },
      ],
      { x: 7.8, y: y - 0.05, w: 4.9, h: 0.75, valign: 'top', objectName: `Config ${i + 1} text` },
    );
  }
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 7.0,
    y: 5.85,
    w: 5.7,
    h: 0.75,
    rectRadius: 0.375,
    fill: { color: C.background1 },
    line: { color: C.background1, width: 0 },
    objectName: 'Call to action',
  });
  T(
    s,
    [
      { text: 'See it for yourself at ', options: { color: '0B2D25' } },
      { text: 'flowza.com', options: { color: C.accent1, bold: true } },
    ],
    {
      x: 7.0,
      y: 5.85,
      w: 5.7,
      h: 0.75,
      fontSize: 20,
      align: 'center',
      valign: 'middle',
      objectName: 'Call to action text',
    },
  );
  s.addNotes(
    'Finally, configure and monitor. Settings cover regional options, attendance rules, sync, notifications and security, while roles decide who sees which branch. Pick one of seven dashboard styles and a layout: Overview, Operations or Executive. The dashboard shows present, absent, on leave and late compared with last week, then the attendance trend, every branch, device status and the approvals waiting for you, with reports in PDF, Excel or CSV. See it for yourself at flowza.com.',
  );
}

await pres.writeFile({ fileName: OUT });
await applyTheme(OUT, THEME);
console.log('wrote', OUT);
