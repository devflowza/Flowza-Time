// FlowZa Time · video 2 · the manager portal (Nasser, IT & QA team lead; Hamed, Head of Technology, manages managers).
import { card, startVideo } from './lib.mjs';

const v = await startVideo('manager');
const { page } = v;
const nav = (name) => v.click(page.getByRole('link', { name, exact: true }).first());
const tab = (name) => v.click(page.getByRole('tab', { name }).first());
const rowOf = (text) => page.locator('tr', { hasText: text }).locator('visible=true').first();

await v.card('title', card({
  eyebrow: 'Video 2 of 5 · Manager portal',
  title: 'Your team today, every request in one inbox',
  subtitle: 'The daily roll call, approvals with context, the month for the team, and managers of managers.',
  points: ['Team › Today: who is in, late, absent, on leave', 'The morning roll call report, every working day', 'Approvals: time away, leave, shift swaps', 'Approve with the context beside it', 'The month for the whole team', 'Managers of managers, through the hierarchy'],
}));

await v.scene('signin', async () => { await v.signIn('manager@albahja.example'); }, { chip: 'Nasser · Line manager' });

await v.scene('today', async () => {
  await v.closeOverlays();
  await nav('Team overview');
  await v.settle(1200);
  await v.hover(page.getByText('In now').first());
  await v.scroll(420);
  await v.hold(1200);
  await v.scroll(-420);
});

await v.scene('rollcall', async () => {
  await v.closeOverlays();
  await nav('Reports');
  await v.settle(1000);
  // "My reports": the Daily Report the morning roll call delivered — his team only
  const list = page.getByRole('heading', { name: 'My reports' }).first();
  await list.evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
  await v.hold(600);
  const row = page.locator('tr', { hasText: 'Daily Report' }).locator('visible=true').first();
  if (await row.count()) await v.hover(row);
  await v.hold(1500);
});

await v.scene('inbox', async () => {
  await v.closeOverlays();
  await nav('Approvals');
  await v.settle(1000);
  await v.hover(page.locator('tbody tr').locator('visible=true').first());
  await v.hold(600);
});

await v.scene('timeaway', async () => {
  await v.closeOverlays();
  await v.click(page.getByRole('button', { name: 'Time away', exact: true }).first());
  await v.settle(900);
  // Huda's personal permission: the request shows the month's allowance beside it
  const row = rowOf('Huda Al Kindi');
  await v.click(row, { dx: 120 });
  await v.settle(1000);
  await v.hold(1400);
  await v.closeOverlays();
  await v.click(rowOf('Huda Al Kindi').getByRole('button', { name: 'Approve' }));
  await v.hold(500);
  const dlg = page.getByRole('dialog');
  await v.click(dlg.getByRole('button', { name: /approve/i }).last());
  await v.settle(900);
});

await v.scene('leave', async () => {
  await v.closeOverlays();
  await v.click(page.getByRole('button', { name: 'Leave', exact: true }).first());
  await v.settle(800);
  const row = page.locator('tbody tr').locator('visible=true').first();
  if (await row.count()) { await v.click(row, { dx: 120 }); await v.settle(900); await v.hold(1600); }
  await v.closeOverlays();
  await v.click(page.getByRole('button', { name: 'All types', exact: true }).first());
  await v.settle(800);
  const swap = page.locator('tbody tr', { hasText: 'Shift swap' }).locator('visible=true').first();
  if (await swap.count()) { await v.click(swap, { dx: 120 }); await v.settle(900); await v.hold(1200); }
});

await v.scene('month', async () => {
  await v.closeOverlays();
  await nav('Team overview');
  await v.settle(700);
  await tab('Attendance');
  await v.settle(1200);
  await v.scroll(300);
  await v.hold(1500);
});

await v.scene('head', async () => {
  await v.closeOverlays();
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
  await v.ctx.clearCookies();
  await v.signIn('head@albahja.example', { delay: 18 });
  await v.setChip('Hamed · Head of Technology');
  await nav('Team overview');
  await v.settle(1200);
  await v.scroll(380);
  await v.hover(page.getByText(/via /i).locator('visible=true').first());
  await v.hold(1200);
}, { chip: 'Hamed · Head of Technology' });

await v.closeOverlays();
await v.card('end', card({
  eyebrow: 'Manager portal',
  title: 'One roll call, one inbox, every level',
  subtitle: 'What a manager sees is enforced twice: by the API and by row-level security in the database.',
}));
await v.finish();
