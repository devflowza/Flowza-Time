import { expect, test } from '@playwright/test';
import { HR_NOTE_ID, NOTE_MANAGER, ORG_ID, hrNotesHandlers, installMockBackend, signInDirectly } from './support/mock-backend';

/**
 * HR attendance notes review (HR portal Prompt 4, Prompt 11 UI suite): HR opens the organisation-wide queue, which says it is
 * oversight; a reason waiting for the employee's line manager is excused by HR as an override that fills the manager's seat
 * (the dialog names whose), and it leaves the "Waiting" filter for "Excused".
 */
test.describe('HR attendance notes review', () => {
  test.beforeEach(async ({ page }) => { await signInDirectly(page); });

  test('organisation queue → excuse a reason as an override of the manager\'s seat → it moves to Excused', async ({ page }) => {
    const notes = hrNotesHandlers();
    const backend = await installMockBackend(page, { get: notes.get, post: notes.post });
    await page.goto('/attendance/notes?scope=all');

    await expect(page.getByRole('heading', { name: 'Attendance reasons' })).toBeVisible();
    await expect(page.getByTestId('oversight-banner')).toContainText('organisation-wide oversight');
    await expect(page.getByRole('button', { name: 'Organisation', pressed: true })).toBeVisible();
    const row = page.getByTestId('note-review-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Maryam Al Lawati');
    await expect(row).toContainText('My child was admitted to hospital overnight');
    await expect(row).toContainText('Awaiting review');

    await row.getByRole('button', { name: 'Excuse', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Excuse the day' })).toBeVisible();
    // HR is not the manager: the decision is an override that fills the manager's seat, and the dialog says whose
    await expect(dialog.getByTestId('note-review-seat-hint')).toContainText(NOTE_MANAGER.userName);
    await dialog.getByLabel('Comment').fill('Hospital letter seen');
    await dialog.getByRole('button', { name: 'Excuse', exact: true }).click();
    await expect(page.getByText('Day excused')).toBeVisible();

    expect(notes.reviews).toEqual([{ decision: 'excuse', reason: 'Hospital letter seen', onBehalfOfUserId: NOTE_MANAGER.userId }]);
    expect(backend.calls.filter((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/attendance/notes/${HR_NOTE_ID}/review`)).toHaveLength(1);
    // decided: no longer waiting, listed under Excused with who decided
    await expect(page.getByTestId('note-review-row')).toHaveCount(0);
    await page.getByRole('button', { name: 'Excused', exact: true }).click();
    await expect(page.getByTestId('note-review-row')).toContainText('Excused');
    await expect(page.getByTestId('note-review-row')).toContainText('Aisha Al Balushi: Hospital letter seen');
    await expect(page.getByTestId('note-review-row').getByRole('button', { name: 'Excuse', exact: true })).toHaveCount(0);
  });

  // Regression (Prompt 11 UI walk): the table sized the reason column to the whole note (its one-line truncation still counts
  // the full text), so the review actions were pushed past the card's edge — at 1280 px "Approve" showed as "✓ A", and in
  // Arabic only the icons were left — reachable only by scrolling the table sideways.
  for (const lang of ['en', 'ar'] as const) {
    test(`a long reason keeps the review actions on screen (${lang})`, async ({ page }) => {
      await page.addInitScript((l) => { window.localStorage.setItem('flowza.locale', l); }, lang);
      const long = 'My child was admitted to hospital overnight after a fever that would not come down; the discharge summary from the Royal Hospital is attached and HR has the original.';
      const notes = hrNotesHandlers({ note: long });
      await installMockBackend(page, { get: notes.get, post: notes.post });
      await page.goto('/attendance/notes?scope=all');
      const row = page.getByTestId('note-review-row');
      await expect(row).toHaveCount(1);
      await expect(row.getByTitle(long)).toBeVisible();
      for (const name of lang === 'en' ? ['Approve', 'Excuse', 'Reject', 'Ask'] : ['قبول', 'إعذار', 'رفض', 'سؤال']) {
        await expect(row.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
      }
    });
  }
});
