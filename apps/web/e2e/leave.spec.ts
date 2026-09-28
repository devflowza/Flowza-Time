import { expect, test } from '@playwright/test';
import { EMPLOYEE_ID, installMockBackend, LEAVE_TYPE_AL, meFixture, ORG_ID, signInDirectly } from './support/mock-backend';

/** A Sunday → Thursday range (five working days: Friday and Saturday are the weekly off) three weeks ahead. */
function nextWorkingWeek(): { from: string; to: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 21 + ((7 - d.getUTCDay()) % 7));
  const from = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 4);
  return { from, to: d.toISOString().slice(0, 10) };
}

test.describe('leave v2 — employee portal', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('an employee applies for leave with a live day count and finds it under Requests', async ({ page }) => {
    const me = meFixture({ roleKey: 'employee', roleName: 'Employee', employeeId: EMPLOYEE_ID, permissions: ['leave.request', 'attendance.view_own', 'attendance.request_correction'] });
    const backend = await installMockBackend(page, { me });
    const { from, to } = nextWorkingWeek();
    // the year the request falls in (late December: next year's page)
    await page.goto(`/my/leave?year=${from.slice(0, 4)}`);
    await expect(page.getByRole('heading', { name: 'My leave' })).toBeVisible();
    // the five totals and a card per type
    await expect(page.getByRole('region', { name: 'Leave totals' })).toContainText('Entitlement');
    await expect(page.getByTestId('leave-type-card').first()).toContainText('Annual Leave');

    await page.getByRole('button', { name: 'Apply for leave' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Apply for leave' });
    await dialog.getByRole('combobox', { name: 'Leave type' }).click();
    await page.getByRole('option', { name: /Annual Leave/ }).click();
    await dialog.getByLabel('From').fill(from);
    await dialog.getByRole('textbox', { name: 'To', exact: true }).fill(to);
    // live day count: five working days, and the balance left after it
    await expect(dialog.getByTestId('leave-preview')).toContainText('This request uses 5 working days.');
    await expect(dialog.getByTestId('leave-preview')).toContainText('25 days of Annual Leave left after this request.');
    await dialog.getByLabel('Reason').fill('Family wedding in Nizwa');
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await expect(dialog).toBeHidden();

    // the request is listed (re-fetched from the API) as pending, with its five days
    const row = page.getByRole('row', { name: /Family wedding in Nizwa/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Pending');
    await expect(row.getByRole('cell').nth(2)).toHaveText('5');
    const post = backend.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/me/leave`);
    expect(post?.body).toMatchObject({ leaveTypeId: LEAVE_TYPE_AL, startDate: from, endDate: to, isHalfDay: false, reason: 'Family wedding in Nizwa' });
  });
});

// Leave v2 review fixes (docs/hr-portal/reviews/07-leave-v2-review.md) — the reviewer's probes T1 / T2 / T6, kept as regressions.
test.describe('leave v2 — review fixes', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });
  const managerMe = () => meFixture({ roleKey: 'manager', roleName: 'Line Manager', employeeId: EMPLOYEE_ID, isManager: true, teamSize: 2, permissions: ['leave.request', 'leave.view_team', 'leave.approve', 'attendance.view_own'] });
  const teamLeavePath = `/orgs/${ORG_ID}/me/team/leave`;

  test('7-P2-7 /my: a manager\'s team leave card is hidden while the team has no upcoming leave (B-62)', async ({ page }) => {
    await installMockBackend(page, { me: managerMe() });
    // the card itself asks for the team's leave, so it is on screen (loading) until the answer arrives
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(teamLeavePath));
    await page.goto('/my');
    await answered;
    await expect(page.getByRole('heading', { name: 'Upcoming holidays' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Team leave', exact: true })).toHaveCount(0);
    await expect(page.getByText('No upcoming leave in your team')).toHaveCount(0);
  });

  test('7-P2-7 /my: with one upcoming leave in the team the card lists it', async ({ page }) => {
    const leave = { id: 'x1', employeeId: 'e1', employeeName: 'Salim Report', employeeNumber: 'E1', leaveTypeId: LEAVE_TYPE_AL, leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', color: '#175cd3', startDate: '2026-12-06', endDate: '2026-12-07', isHalfDay: false, halfDayPart: null, days: 2, status: 'PENDING' };
    await installMockBackend(page, { me: managerMe(), get: { [teamLeavePath]: { data: [leave] } } });
    await page.goto('/my');
    await expect(page.getByRole('heading', { name: 'Team leave', exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Team leave' })).toContainText('Salim Report');
  });

  test('7-P2-6 the year-close toast\'s View opens the allocations of the year it fills, never /sync/<job id>', async ({ page }) => {
    const backend = await installMockBackend(page, { me: meFixture() });
    await page.goto('/leave?tab=allocations');
    const close = page.getByRole('button', { name: /Close \d{4} → \d{4}/ }).first();
    const toYear = Number((await close.innerText()).match(/→ (\d{4})/)?.[1]);
    await close.click();
    await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: /Close \d{4} → \d{4}/ }).click();
    await page.getByRole('button', { name: 'View' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/leave' && url.searchParams.get('tab') === 'allocations' && url.searchParams.get('year') === String(toYear));
    expect(backend.calls.some((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/leave-allocations/year-close`)).toBe(true);
    expect(new URL(page.url()).pathname.startsWith('/sync/')).toBe(false);
  });
});
