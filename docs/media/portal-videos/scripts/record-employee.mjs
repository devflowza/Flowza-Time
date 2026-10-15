// FlowZa Time · video 1 · the employee portal (Ahmed Al Hinai, QA technician, shift 08:00–14:00, entry-only terminal).
import { card, startVideo } from './lib.mjs';

const v = await startVideo('employee');
const { page } = v;
const nav = (name) => v.click(page.getByRole('link', { name, exact: true }).first());
const tab = (name) => v.click(page.getByRole('tab', { name }).first());

await v.card('title', card({
  eyebrow: 'Video 1 of 5 · Employee portal',
  title: 'Everything an employee needs, in one portal',
  subtitle: 'Attendance, time on site and time away, step out and come back, leave and shift swaps.',
  points: ['My overview and today', 'The attendance calendar, day by day', 'Activity: on site vs time away', 'Step out / I’m back', 'Plan time away (official, permission)', 'Leave balances and apply', 'Shift swap with a colleague'],
}));

await v.scene('signin', async () => { await v.signIn('employee@albahja.example'); }, { chip: 'Ahmed · Employee' });

await v.scene('overview', async () => {
  await v.settle(900);
  await v.hover(page.getByText(/today/i).first());
  await v.scroll(420);
  await v.hold(900);
  await v.scroll(-420);
});

await v.scene('calendar', async () => {
  await nav('My attendance');
  await v.settle(900);
  // a day with an approved two-hour client visit (official duty counts as worked)
  await v.click(page.getByRole('button', { name: /^2026-10-07/ }).first());
  await v.settle(1400);
  await v.hold(900);
  await v.scroll(300);
});

await v.scene('activity', async () => {
  await v.closeOverlays();
  await tab('Activity');
  await v.settle(1200);
  const range = page.getByRole('combobox').filter({ hasText: /^week$/i }).first();
  if (await range.count()) {
    await v.click(range);
    await v.click(page.getByRole('option', { name: /^month$/i }).first());
    await v.settle(1000);
  }
  await v.scroll(420);
  await v.hold(1500);
});

await v.scene('stepout', async () => {
  await nav('Check in / out');
  await v.settle(900);
  await v.click(page.getByTestId('time-away-step-out'));
  await v.hold(500);
  await v.click(page.getByRole('dialog').getByText('Official duty', { exact: true }).first());
  const back = page.locator('#step-out-back');
  await v.click(back);
  const at = new Date(Date.now() + 2 * 3_600_000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Muscat', hour: '2-digit', minute: '2-digit', hour12: false });
  await back.fill(at);
  await v.type('#step-out-reason', 'Client visit — Oman LNG quality audit', { delay: 26 });
  await v.type('#step-out-destination', 'Oman LNG, Sur', { delay: 30 });
  await v.click(page.getByRole('dialog').getByRole('button', { name: 'Step out now' }));
  await v.settle(1200);
});

await v.scene('back', async () => {
  await v.hover(page.getByTestId('time-away-away'));
  await v.hold(1600);
  const back = page.getByTestId('time-away-back');
  if (await back.count()) { await v.click(back); await v.settle(1200); }
  await v.scroll(320);
});

await v.scene('requests', async () => {
  await v.closeOverlays();
  await nav('My requests');
  await v.settle(800);
  await tab('Time away');
  await v.settle(900);
  await v.click(page.getByTestId('time-away-request'));
  await v.hold(500);
  await v.click(page.getByRole('dialog').getByText('Personal permission', { exact: true }).first());
  await v.hover(page.getByTestId('personal-quota'));
  await v.hold(1200);
});

await v.scene('leave', async () => {
  await v.closeOverlays();
  await nav('My leave');
  await v.settle(900);
  await v.click(page.getByRole('button', { name: 'Apply for leave' }).first());
  await v.hold(500);
  const dlg = page.getByRole('dialog');
  await v.click(dlg.getByRole('combobox').first());
  await v.click(page.getByRole('option', { name: /annual/i }).first());
  await v.click(dlg.locator('input[type=date]').nth(0)); await dlg.locator('input[type=date]').nth(0).fill('2026-11-15');
  await v.click(dlg.locator('input[type=date]').nth(1)); await dlg.locator('input[type=date]').nth(1).fill('2026-11-17');
  await v.hold(600);
  const reason = dlg.locator('textarea').first();
  if (await reason.count()) await v.type(reason, 'Family wedding in Salalah', { delay: 26 });
  await v.hover(dlg.getByText(/working day/i).first());
  await v.hold(900);
  await v.click(dlg.getByRole('button', { name: 'Send request' }));
  await v.settle(900);
});

await v.scene('swap', async () => {
  await v.closeOverlays();
  await nav('My shift');
  await v.settle(900);
  await v.click(page.getByRole('button', { name: /request a swap/i }).first());
  await v.settle(900); // the colleague list loads and the dialog re-centres
  const dlg = page.getByRole('dialog');
  await v.click(dlg.getByRole('combobox').first());
  await v.click(page.getByRole('option', { name: /Tue 27 Oct/ }).first());
  await v.hold(500);
  await v.type(dlg.getByPlaceholder('Search colleagues'), 'Huda', { delay: 70 });
  await v.settle(900);
  await v.click(dlg.getByText('Huda Al Kindi').first());
  await v.hold(500);
  await v.type(dlg.locator('textarea').first(), 'Medical check-up in the morning', { delay: 26 });
  await v.click(dlg.getByRole('button', { name: 'Send request' }));
  await v.settle(900);
});

await v.closeOverlays();
await v.card('end', card({
  eyebrow: 'Employee portal',
  title: 'Attendance, time away, leave and swaps — one portal',
  subtitle: 'Every figure comes from the punches and the same attendance engine HR and payroll use.',
}));
await v.finish();
