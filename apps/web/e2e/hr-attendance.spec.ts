import { expect, test, type Page } from '@playwright/test';
import { employeesFixture, hrWorkspaceHandlers, installMockBackend, ORG_ID, signInDirectly } from './support/mock-backend';

/** DataTable renders a table and a card fallback; assert on the copy that is on screen for this viewport. */
const onScreen = (page: Page, text: string | RegExp) => page.getByText(text).locator('visible=true').first();

/**
 * HR portal Prompt 6a — the HR attendance workspace: the calendar register, adding a missing day through the policy preview,
 * and the monthly summary with its export (a queued report since the review, defect 10).
 */
test.describe('HR attendance workspace', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('calendar → add a missing day with the policy preview → monthly summary', async ({ page }) => {
    const hr = hrWorkspaceHandlers();
    const backend = await installMockBackend(page, { get: hr.get, post: hr.post });
    const salim = employeesFixture[0]!;
    await page.goto('/attendance?tab=calendar&month=2026-09');

    // the calendar: one month per employee, status colours, today's ring, the manual marker and the legend
    const card = page.locator(`[data-testid="calendar-employee"][data-employee="${salim.id}"]`);
    await expect(card).toBeVisible();
    // realtime websockets are aborted in this suite: the register says it refreshes on a timer instead of claiming "Live"
    await expect(page.getByTestId('attendance-live')).toHaveText('Auto-refresh');
    await expect(card.locator('[data-day="2026-09-01"]')).toHaveAttribute('data-status', 'PRESENT');
    await expect(card.locator('[data-day="2026-09-08"]')).toHaveAttribute('data-status', 'PRESENT');
    await expect(card.locator('[data-day="2026-09-20"]')).toHaveAttribute('data-today', 'true');
    await expect(page.locator('[data-testid="calendar-employee"] [data-testid="manual-marker"]')).toHaveCount(1);
    await expect(page.getByTestId('calendar-legend')).toContainText('Manual status');

    // an empty past day opens HR's Add record for that employee and date
    await card.locator('[data-day="2026-09-14"]').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add record' })).toBeVisible();
    await expect(dialog.getByTestId('expected-shift')).toContainText('Day shift');
    await expect(dialog.getByTestId('expected-shift')).toContainText('08:00 – 17:00');
    await dialog.getByLabel('Check-in', { exact: true }).fill('08:00');
    await dialog.getByLabel('Check-out', { exact: true }).fill('16:30');
    // the engine's verdict on the proposed times, before anything is written
    await expect(dialog.getByTestId('edit-plan')).toContainText('Add punch');
    await expect(dialog.getByTestId('outcome-after')).toContainText('Present');
    await expect(dialog.getByTestId('outcome-after')).toContainText('Early departure');
    await dialog.getByRole('button', { name: 'Save record' }).click();
    await expect(dialog.getByText('Give a reason (at least 3 characters).')).toBeVisible();
    await dialog.getByLabel(/^Reason/).fill('Device was offline — confirmed by the supervisor');
    await dialog.getByRole('button', { name: 'Save record' }).click();
    await expect(page.getByText('Record updated')).toBeVisible();
    const edit = backend.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/attendance/record-edits`);
    expect(edit?.body).toEqual({ employeeId: salim.id, date: '2026-09-14', reason: 'Device was offline — confirmed by the supervisor', inAt: '2026-09-14T04:00:00Z', outAt: '2026-09-14T12:30:00Z' });
    // the preview never writes: it only ever went to /attendance/preview
    expect(backend.calls.filter((c) => c.path === `/orgs/${ORG_ID}/attendance/preview`).length).toBeGreaterThan(0);

    // the monthly summary
    await page.goto('/attendance/summary?month=2026-09');
    await expect(page.getByRole('heading', { level: 1, name: 'Attendance summary' })).toBeVisible();
    await expect(onScreen(page, salim.displayName)).toBeVisible();
    await expect(page.getByTestId('summary-totals')).toContainText('36');
    await expect(page.getByTestId('summary-export')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Unexcused' })).toBeAttached();
    // the export queues a report in the chosen format and points at Reports — no file is built in the browser
    await page.getByTestId('summary-export').click();
    await page.getByTestId('summary-export-xlsx').click();
    await expect(page.getByText('Queued successfully')).toBeVisible();
    const exported = backend.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/attendance/summary/export`);
    expect(exported?.body).toMatchObject({ month: '2026-09', format: 'xlsx' });
  });
});
