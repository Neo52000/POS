import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureSessionOpen, login, navLink, resetStorage } from './helpers';

/** Mouvements d'espèces hors vente (0.5.0) : saisie, bon imprimé, lecture X et Z1. */

async function sellCahierCash(page: Page): Promise<void> {
  await page.getByTestId('product-search').fill('cahier');
  await page.getByTestId('product-tile').filter({ hasText: 'Cahier' }).first().click();
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cash').click();
  await page.getByTestId('cash-shortcut-500').click();
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-success')).toBeVisible();
  await page.getByTestId('close-success').click();
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });
}

async function addMovement(
  page: Page,
  kind: 'bank_deposit' | 'withdrawal' | 'cash_in',
  amount: string,
  reference?: string,
): Promise<void> {
  await page.getByTestId('cash-movement-button').click();
  const dialog = page.getByTestId('cash-movement-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId(`cash-movement-kind-${kind}`).click();
  await page.getByTestId('cash-movement-amount-input').fill(amount);
  if (reference) await page.getByTestId('cash-movement-reference').fill(reference);
  await page.getByTestId('cash-movement-submit').click();
  await expect(dialog).toBeHidden();
}

const printedTitles = (page: Page) =>
  page.evaluate(() =>
    ((globalThis as { __posMockPrinted?: Array<{ title?: string }> }).__posMockPrinted ?? []).map(
      (p) => p.title ?? '',
    ),
  );

test.beforeEach(async ({ page }) => {
  await resetStorage(page);
  await login(page);
  await ensureSessionOpen(page);
});

test('remise en banque et apport : bon imprimé, espèces attendues en X et au Z1', async ({
  page,
}) => {
  // Fond 50,00 + vente espèces 2,45 = 52,45 attendus.
  await sellCahierCash(page);
  await navLink(page, 'Caisse').click();
  await expect(page.getByTestId('cash-movements')).toBeVisible();

  // Montant et motif obligatoires.
  await page.getByTestId('cash-movement-button').click();
  await expect(page.getByTestId('cash-movement-submit')).toBeDisabled();
  await page.getByTestId('cash-movement-reason').fill('');
  await page.getByTestId('cash-movement-amount-input').fill('30');
  await expect(page.getByTestId('cash-movement-submit')).toBeDisabled();
  await page.keyboard.press('Escape');

  await addMovement(page, 'bank_deposit', '30', 'B-42');
  await addMovement(page, 'cash_in', '10');
  await expect(page.getByTestId('cash-movement-row')).toHaveCount(2);
  await expect(page.getByTestId('cash-movement-row').first()).toContainText('Remise en banque');
  await expect(page.getByTestId('cash-movement-row').first()).toContainText('réf. B-42');
  await expect(page.getByTestId('cash-movements-total')).toContainText('Solde');

  // Un bon par mouvement, au format rapport (pont 0.2.1).
  const titles = await printedTitles(page);
  expect(titles.filter((t) => t === "MOUVEMENT D'ESPÈCES")).toHaveLength(2);

  // Lecture X : 52,45 − 30,00 + 10,00 = 32,45, mouvements détaillés.
  await navLink(page, 'Rapports').click();
  await page.getByTestId('x-read').click();
  const x = page.getByTestId('report-preview');
  await expect(x).toContainText("Mouvements d'espèces");
  await expect(x).toContainText('Remise en banque');
  await expect(x).toContainText('Sorties (banque, retraits)');
  await expect(x).toContainText(/Espèces attendues\s*32,45/);

  // Z1 : même attendu, section des mouvements, écart sur le comptage.
  await navLink(page, 'Caisse').click();
  await page.getByTestId('close-session-button').click();
  await expect(page.getByTestId('closing-result')).toBeVisible();
  const z = page.getByTestId('closing-result').getByTestId('report-preview');
  await expect(z).toContainText('CLÔTURE JOURNALIÈRE Z1');
  await expect(z).toContainText("Mouvements d'espèces");
  await expect(z).toContainText(/Espèces attendues\s*32,45/);
  await expect(page.getByTestId('variance')).toHaveText(/32,45/);

  // Duplicata du Z1 (Rapports) : mouvements relus.
  await navLink(page, 'Rapports').click();
  await page.getByTestId('report-tab-z1').click();
  await expect(page.getByTestId('report-preview')).toContainText("Mouvements d'espèces");
});
