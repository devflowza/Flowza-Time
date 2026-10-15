// FlowZa Time · video 5 · between check-in and check-out: the two site layouts, terminal punch roles, the time-away policy,
// how every gap is classified (with the calculation trace), the chart, meeting-room readers and the HR report.
import { card, startVideo } from './lib.mjs';
import { layoutsCard, rulesCard } from './cards.mjs';

const AHMED = '8f1ab278-569b-b1b2-c404-1f3b612760f7';
const v = await startVideo('timeaway');
const { page } = v;
const nav = (name) => v.click(page.getByRole('link', { name, exact: true }).first());

/** Open Ahmed's day in the attendance register and show its calculation (the time-away part of the trace). */
async function openDay(date) {
  await v.goto(`/attendance?tab=daily&date=${date}&search=Ahmed%20Al%20Hinai`);
  await v.settle(1200);
  const row = page.locator('tr', { hasText: 'Ahmed Al Hinai' }).locator('visible=true').first();
  await v.click(row, { dx: 150 });
  await v.settle(1300);
  // the engine's time-away step: every gap with its classification
  const step = page.getByRole('dialog').getByText('timeAway', { exact: true }).first();
  if (await step.count()) await v.hover(step);
}

await v.card('title', card({
  eyebrow: 'Video 5 of 5 · Between check-in and check-out',
  title: 'Every minute between check-in and check-out',
  subtitle: 'Out and back during working hours: official duty, personal permission, unapproved time — and meeting rooms.',
  points: ['Two-way terminals, or an entry terminal + the portal', 'Terminal punch roles', 'The time-away policy', 'How each gap is classified', 'The same picture for employee and manager', 'Meeting-room readers: attendance and access', 'The monthly HR report'],
}));

await v.scene('signin', async () => { await v.signIn('owner@albahja.example', { delay: 16 }); }, { caption: 'Signed in as the administrator, to see every part of it.', chip: 'Khalid · Owner', pad: 200 });

await v.card('layouts', layoutsCard(), { min: 2000 });

await v.scene('devices', async () => {
  await v.closeOverlays();
  await v.goto('/devices');
  await v.settle(1200);
  for (const code of ['MCT-ENT-01', 'MCT-PKG-01', 'MCT-ENT-02', 'MCT-BRD-01']) {
    const row = page.locator('tr', { hasText: code }).locator('visible=true').first();
    if (await row.count()) await v.hover(row, { after: 700 });
  }
}, { chip: 'Terminals' });

await v.scene('policy', async () => {
  await v.closeOverlays();
  await v.goto('/shifts?tab=rules');
  await v.settle(1200);
  const row = page.locator('tr', { hasText: 'Office day with time away' }).locator('visible=true').first();
  await v.hover(row);
  await v.click(row.getByRole('button').last());
  await v.click(page.getByRole('menuitem', { name: 'Edit' }).first());
  await v.settle(1000);
  const tab = page.getByRole('dialog').getByRole('tab', { name: /time away/i }).first();
  if (await tab.count()) { await v.click(tab); await v.settle(700); }
  await v.scroll(260);
  await v.hold(1500);
}, { chip: 'Attendance policy' });

await v.scene('trace', async () => { await v.closeOverlays(); await openDay('2026-10-07'); await v.hold(1200); }, { chip: 'Ahmed · 7 October' });

await v.scene('unapproved', async () => { await v.closeOverlays(); await openDay('2026-10-04'); await v.hold(1200); }, { chip: 'Ahmed · 4 October' });

await v.scene('chart', async () => {
  await v.closeOverlays();
  await v.goto(`/employees/${AHMED}?tab=activity`);
  await v.settle(1500);
  const month = page.getByRole('combobox').filter({ hasText: /week/i }).first();
  if (await month.count()) {
    await v.click(month);
    const opt = page.getByRole('option', { name: /^month$/i }).first();
    if (await opt.count()) await v.click(opt); else await page.keyboard.press('Escape');
    await v.settle(1000);
  }
  await v.scroll(520);
  await v.hold(1500);
}, { chip: 'Activity' });

await v.scene('meetings', async () => {
  await v.closeOverlays();
  await v.goto('/meetings?date=2026-10-14');
  await v.settle(1200);
  const m = page.getByText('Weekly QA review').locator('visible=true').first();
  if (await m.count()) { await v.click(m); await v.settle(1000); await v.scroll(260); await v.hold(3500); }
  await v.closeOverlays();
  const log = page.getByRole('tab', { name: 'Access log' }).first();
  if (await log.count()) { await v.click(log); await v.settle(1000); await v.hold(900); }
}, { chip: 'Meeting rooms' });

await v.scene('report', async () => {
  await v.closeOverlays();
  await nav('Time away');
  await v.settle(1300);
  await v.scroll(300);
  await v.hold(1200);
}, { chip: 'HR report' });

await v.closeOverlays();
await v.card('end', rulesCard(), { min: 2500 });
await v.finish();
