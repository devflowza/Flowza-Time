// FlowZa Time · video 4 · the administrator (Khalid, owner): settings, users and roles, terminals, locations, audit.
import { card, startVideo } from './lib.mjs';

const v = await startVideo('admin');
const { page } = v;
const nav = (name) => v.click(page.getByRole('link', { name, exact: true }).first());
const tab = (name) => v.click(page.getByRole('tab', { name }).first());

await v.card('title', card({
  eyebrow: 'Video 4 of 5 · Administration',
  title: 'The administrator’s console',
  subtitle: 'Settings, people and roles, terminals and what their punches mean, locations and meeting rooms, and the audit log.',
  points: ['Settings, incl. the manager team scope', 'Users and roles (permissions, branches)', 'Terminals by punch role', 'Registering a terminal', 'Locations: branches, floors, rooms', 'The audit log'],
}));

await v.scene('signin', async () => { await v.signIn('owner@albahja.example'); }, { chip: 'Khalid · Owner' });

await v.scene('settings', async () => {
  await v.closeOverlays();
  await v.goto('/settings/general');
  await v.settle(900);
  await v.click(page.getByRole('link', { name: /^attendance$/i }).last());
  await v.settle(900);
  const scope = page.locator('#att-team-scope');
  await scope.scrollIntoViewIfNeeded().catch(() => {});
  await v.hold(400);
  await v.click(scope);
  await v.hold(1200);
  await v.click(page.getByRole('option', { name: /hierarchy/i }).first());
  await v.hold(800);
});

await v.scene('users', async () => {
  await v.closeOverlays();
  await nav('Users & roles');
  await v.settle(1000);
  await v.hover(page.locator('tbody tr').locator('visible=true').nth(2));
  await tab('Roles');
  await v.settle(900);
  const role = page.getByText('Line manager', { exact: true }).locator('visible=true').first();
  if (await role.count()) { await v.click(role); await v.settle(1200); await v.scroll(380); await v.hold(900); }
});

await v.scene('devices', async () => {
  await v.closeOverlays();
  await nav('Devices');
  await v.settle(1200);
  for (const code of ['MCT-ENT-01', 'MCT-PKG-01', 'MCT-BRD-01']) {
    const row = page.locator('tr', { hasText: code }).locator('visible=true').first();
    if (await row.count()) await v.hover(row, { after: 650 });
  }
});

await v.scene('register', async () => {
  await v.closeOverlays();
  await v.click(page.getByRole('button', { name: 'Register device' }).first(), { center: true });
  await page.waitForURL(/\/devices\/new/, { timeout: 10_000 });
  await v.settle(900);
  await v.click(page.getByRole('main').getByText('Mock device (simulator)').first(), { center: true });
  await v.click(page.getByRole('button', { name: /^next/i }).last());
  await v.settle(700);
  await v.type('#dev-code', 'MCT-TRN-02', { delay: 40 });
  await v.type('#dev-name', 'Training room door', { delay: 34 });
  const role = page.locator('#dev-punch-role');
  await role.scrollIntoViewIfNeeded().catch(() => {});
  await v.click(role);
  await v.hold(900);
  await v.click(page.getByRole('option', { name: /meeting-room reader/i }).first());
  await v.hold(1400);
});

await v.scene('locations', async () => {
  await v.closeOverlays();
  await v.goto('/organization?tab=locations');
  await v.settle(1300);
  await v.scroll(300);
  await v.hold(1500);
});

await v.scene('audit', async () => {
  await v.closeOverlays();
  await nav('Audit log');
  await v.settle(1300);
  // a request an employee filed today (time away), with who / what / when
  const row = page.locator('tbody tr', { hasText: 'time_away_requested' }).locator('visible=true').first();
  if (await row.count()) { await v.click(row.getByText('View changes'), { center: true }); await v.settle(900); await v.hold(1400); }
});

await v.closeOverlays();
await v.card('end', card({
  eyebrow: 'Administration',
  title: 'Everything under control, in one console',
  subtitle: 'Permissions come from the database and are enforced twice: by the API and by row-level security.',
}));
await v.finish();
