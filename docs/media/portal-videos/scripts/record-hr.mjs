// FlowZa Time · video 3 · HR (Fatma, HR Manager): the whole organisation, departments, time away, holidays, leave, meetings.
import { card, startVideo } from './lib.mjs';

const v = await startVideo('hr');
const { page } = v;
const nav = (name) => v.click(page.getByRole('link', { name, exact: true }).first());
const tab = (name) => v.click(page.getByRole('tab', { name }).first());

await v.card('title', card({
  eyebrow: 'Video 3 of 5 · HR',
  title: 'The whole organisation, for HR',
  subtitle: 'Every branch and department, time away, the morning roll call, holidays, leave and meeting attendance.',
  points: ['Dashboard across branches', 'Daily attendance by department', 'The Time away report', 'Schedule the morning roll call', 'Organisation and org chart', 'Holidays: add and remove', 'Leave: requests, calendar, balances', 'Meetings: who attended'],
}));

await v.scene('signin', async () => { await v.signIn('hr@albahja.example'); }, { chip: 'Fatma · HR Manager' });

await v.scene('dashboard', async () => {
  await v.closeOverlays();
  await nav('Dashboard');
  await v.settle(1500);
  await v.scroll(450);
  await v.hold(1000);
  await v.scroll(450);
  await v.hold(800);
});

await v.scene('daily', async () => {
  await v.closeOverlays();
  await nav('Attendance');
  await v.settle(1200);
  const dept = page.getByRole('combobox').filter({ hasText: /^Department$/ }).first();
  if (await dept.count()) {
    await v.click(dept);
    await page.keyboard.type('Quality', { delay: 60 });
    await v.hold(500);
    await v.click(page.getByRole('option', { name: /quality assurance/i }).first());
    await v.settle(1000);
  }
  const row = page.locator('tbody tr').locator('visible=true').first();
  if (await row.count()) { await v.click(row, { dx: 160 }); await v.settle(1200); await v.hold(1200); }
});

await v.scene('timeaway', async () => {
  await v.closeOverlays();
  await nav('Time away');
  await v.settle(1400);
  await v.hover(page.getByText('Unapproved').locator('visible=true').first());
  await v.scroll(380);
  await v.hold(1200);
  const row = page.locator('tbody tr', { hasText: 'Ahmed' }).locator('visible=true').first();
  if (await row.count()) { await v.click(row, { dx: 160 }); await v.settle(900); }
  await v.scroll(420);
  await v.hold(900);
});

await v.scene('schedule', async () => {
  await v.closeOverlays();
  await nav('Reports');
  await v.settle(1200);
  const s = page.getByText('Morning roll call').locator('visible=true').first();
  await s.scrollIntoViewIfNeeded().catch(() => {});
  await v.hover(s);
  await v.hold(600);
  const edit = page.locator('tr', { hasText: 'Morning roll call' }).locator('visible=true').first().getByRole('button', { name: 'Edit' });
  if (await edit.count()) {
    await v.click(edit);
    await v.settle(700);
    const dlg = page.getByTestId('schedule-dialog');
    if (await dlg.count()) { await v.hover(dlg.locator('#sc-days')); await v.hold(1800); }
  }
});

await v.scene('structure', async () => {
  await v.closeOverlays();
  await nav('Organisation');
  await v.settle(1200);
  const deps = page.getByRole('tab', { name: /departments/i }).first();
  if (await deps.count()) { await v.click(deps); await v.settle(900); }
  await v.hold(700);
  await nav('Org chart');
  await v.settle(1600);
  await v.hold(1200);
});

await v.scene('holidays', async () => {
  await v.closeOverlays();
  await nav('Holidays');
  await v.settle(1000);
  await v.click(page.getByRole('button', { name: 'Add holiday' }).first());
  await v.hold(500);
  await v.type('#hd-name', 'Company foundation day', { delay: 30 });
  const date = page.locator('#hd-date');
  await v.click(date); await date.fill('2026-12-10');
  await v.hold(600);
  await v.click(page.getByRole('dialog').getByRole('button', { name: 'Create' }));
  await v.settle(1200);
  const row = page.locator('div.flex.items-center', { hasText: 'Company foundation day' }).last();
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await v.hover(row);
  await v.hold(1500); // the "Holiday created" toast fades before the row's menu is opened
  await v.click(row.getByRole('button', { name: 'Actions' }), { center: true });
  await v.click(page.getByRole('menuitem', { name: 'Delete' }));
  await v.hold(500);
  await v.click(page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'Delete' }).last());
  await v.settle(900);
});

await v.scene('leave', async () => {
  await v.closeOverlays();
  await nav('Leave');
  await v.settle(1200);
  for (const name of [/calendar/i, /balances/i]) {
    const t = page.getByRole('tab', { name }).first();
    if (await t.count()) { await v.click(t); await v.settle(1000); await v.hold(500); }
  }
});

await v.scene('meetings', async () => {
  await v.closeOverlays();
  await nav('Meetings');
  await v.settle(1200);
  const meeting = page.getByText('Sprint planning — release 4.2').locator('visible=true').first();
  if (await meeting.count()) { await v.click(meeting); await v.settle(1000); await v.scroll(300); await v.hold(1500); }
});

await v.closeOverlays();
await v.card('end', card({
  eyebrow: 'HR',
  title: 'One view of the organisation',
  subtitle: 'Every figure on these pages is recalculated from the punches when a policy, a holiday or an approval changes.',
}));
await v.finish();
