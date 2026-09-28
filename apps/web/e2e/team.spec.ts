import { expect, test } from '@playwright/test';
import { installMockBackend, LINE_MANAGER_PERMISSIONS, MANAGER_EMPLOYEE_ID, meFixture, ORG_ID, signInDirectly, TEAM_NOTE_ID, teamHandlers } from './support/mock-backend';

/**
 * HR portal Prompt 5 — the line manager's day: today's board of the direct reports, the reason one of them gave for a late day
 * waiting on the Approvals tab, a rejection with a half-day pay effect, and the manager badge dropping to nothing. The manager
 * holds the team keys and no approve key (Finance B-66: their approvals live on /team).
 */
test.describe('Team workspace', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('team today → approvals → reject a reason with a half-day pay effect → the count drops', async ({ page }) => {
    const team = teamHandlers();
    const me = meFixture({ roleKey: 'team_lead', roleName: 'Team Lead', permissions: [...LINE_MANAGER_PERMISSIONS], employeeId: MANAGER_EMPLOYEE_ID, isManager: true, teamSize: 2 });
    const backend = await installMockBackend(page, { me, get: team.get, post: team.post });
    await page.goto('/team');

    // Today: one card per report, the late arrival and the leave, and what waits for the manager
    await expect(page.getByRole('heading', { level: 1, name: 'My team' })).toBeVisible();
    const cards = page.getByTestId('team-member-card');
    await expect(cards).toHaveCount(2);
    const salim = cards.filter({ hasText: 'Salim Al Harthy' });
    await expect(salim.getByTestId('team-status')).toHaveText('Late');
    await expect(salim.getByText('17m late')).toBeVisible();
    await expect(salim.getByTestId('live-state')).toHaveText('In now');
    await expect(cards.filter({ hasText: 'Khalid Al Balushi' }).getByText('Annual Leave')).toBeVisible();
    // the manager badge next to the bell: one reason waiting, and it leads to the team queue
    const chip = page.getByTestId('pending-chip');
    await expect(chip).toHaveText('1');
    await expect(chip).toHaveAttribute('href', '/team?tab=approvals');

    // Approvals: the reason, with Prompt 4's actions (the row waits for this manager)
    await salim.getByTestId('pending-badge').click();
    await expect(page.getByRole('tab', { name: /Approvals/, selected: true })).toBeVisible();
    const row = page.getByTestId('team-note-row').filter({ hasText: 'Road closed near the Wadi Kabir roundabout' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('excused-count')).toBeVisible();
    await row.getByRole('button', { name: 'Reject' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: /Reject/ })).toBeVisible();
    await dialog.getByText('Half day', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByText('Reason rejected')).toBeVisible();

    const review = backend.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/attendance/notes/${TEAM_NOTE_ID}/review`);
    expect(review?.body).toEqual({ decision: 'reject', payEffectDays: 0.5 });
    // decided: the queue empties and the badge drops to nothing
    await expect(page.getByText('No reasons are waiting for you')).toBeVisible();
    await expect(chip).toHaveCount(0);
    await expect(page.getByTestId('approvals-tab-count')).toHaveCount(0);
  });
});
