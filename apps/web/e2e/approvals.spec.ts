import { expect, test, type Page } from '@playwright/test';
import { APPROVAL_ID, approvalsHandlers, COLLEAGUE, installMockBackend, ORG_ID, signInDirectly } from './support/mock-backend';

/** DataTable renders a table and a card fallback; act on the copy that is on screen for this viewport. */
const onScreen = (page: Page, text: string | RegExp) => page.getByText(text).locator('visible=true').first();

/**
 * Approval engine v2 (review P2-12): the inbox with a decision and its comment, one request's levels and timeline, creating
 * and listing a delegation, and the workflow editor's validation — against the API double in support/mock-backend.ts.
 */
test.describe('Approvals', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('P2-12 inbox → approve the level waiting for me, with a comment', async ({ page }) => {
    const handlers = approvalsHandlers();
    const backend = await installMockBackend(page, { get: handlers.get, post: handlers.post });
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    await expect(onScreen(page, 'Salim Al Harthy')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).locator('visible=true').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Approve request' })).toBeVisible();
    await expect(dialog).toContainText('Level 2 of 2');
    await dialog.getByLabel(/Comment/).fill('Enjoy the wedding');
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Request approved')).toBeVisible();
    const decision = backend.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/approvals/${APPROVAL_ID}/decide`);
    // the decision names the level the approver saw (review P1-2)
    expect(decision?.body).toEqual({ stepNo: 2, decision: 'APPROVE', comment: 'Enjoy the wedding' });
    // decided: it leaves the queue
    await expect(page.getByText('Nothing waiting for you').locator('visible=true').first()).toBeVisible();
  });

  test('P2-12 request panel → every level with its approvers and the timeline', async ({ page }) => {
    const handlers = approvalsHandlers();
    await installMockBackend(page, { get: handlers.get, post: handlers.post });
    await page.goto(`/approvals?request=${APPROVAL_ID}`);
    const panel = page.getByRole('dialog');
    await expect(panel.getByText('Annual Leave')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Levels' })).toBeVisible();
    await expect(panel.getByText('Khalid Manager').first()).toBeVisible();
    await expect(panel.getByText('“Fine by me”').first()).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await expect(panel.getByText('Submitted', { exact: true })).toBeVisible();
    await expect(panel.getByText('Level 1 approved')).toBeVisible();
    await expect(panel.getByText('Moved to level 2')).toBeVisible();
  });

  test('P2-12 delegations → delegate my approvals to a colleague and see it listed', async ({ page }) => {
    const handlers = approvalsHandlers();
    const backend = await installMockBackend(page, { get: handlers.get, post: handlers.post });
    await page.goto('/approvals/delegations');
    await expect(page.getByRole('heading', { level: 1, name: 'Delegations' })).toBeVisible();
    await expect(page.getByText('No delegations')).toBeVisible();
    await page.getByRole('button', { name: 'Add delegation' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#dlg-delegate').click();
    await page.getByRole('option', { name: new RegExp(COLLEAGUE.fullName) }).click();
    await dialog.getByLabel('Leave', { exact: true }).check();
    await dialog.getByLabel(/Reason/).fill('Annual leave');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Delegation created')).toBeVisible();
    const created = backend.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/approval-delegations`);
    expect(created?.body).toMatchObject({ delegateUserId: COLLEAGUE.userId, entityTypes: ['LEAVE'], reason: 'Annual leave' });
    // the list shows it, active
    const row = page.getByRole('row', { name: new RegExp(COLLEAGUE.fullName) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Active');
    await expect(row).toContainText('Leave');
  });

  test('P2-12 workflow editor → a quorum above one on the manager is refused; one approval saves', async ({ page }) => {
    const handlers = approvalsHandlers();
    const backend = await installMockBackend(page, { get: handlers.get, post: handlers.post });
    await page.goto('/approvals/workflows');
    await expect(page.getByRole('heading', { level: 1, name: 'Approval workflows' })).toBeVisible();
    await page.getByRole('button', { name: 'Add workflow' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Name/).fill('Manager quorum');
    // no self-approval switch anywhere (review P0-3)
    await expect(dialog.getByRole('switch', { name: /self-approval/i })).toHaveCount(0);
    const level = dialog.getByTestId('wf-step-0');
    await level.getByLabel('Decision').click();
    await page.getByRole('option', { name: 'A number of them' }).click();
    await level.getByLabel('Approvals needed').fill('2');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(level.getByText('This approver type is one person: it cannot require more than 1 approval.')).toBeVisible();
    expect(backend.calls.some((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/approval-workflows`)).toBe(false);
    await level.getByLabel('Approvals needed').fill('1');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Workflow created')).toBeVisible();
    const created = backend.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/approval-workflows`);
    expect(created?.body).toMatchObject({ name: 'Manager quorum', steps: [{ order: 1, approverType: 'MANAGER', mode: 'QUORUM', requiredCount: 1 }] });
    expect(created?.body).not.toHaveProperty('allowSelfApproval');
  });
});
