import { expect, test } from '@playwright/test';
import { ensureSessionOpen, login, resetStorage } from './helpers';

/** Parcours de bout en bout en mode mock (`VITE_E2E_MOCK=1`). */

test.beforeEach(async ({ page }) => {
  await resetStorage(page);
});

test('vente : login → ouverture session → recherche → remise 10 % → CB → ticket', async ({
  page,
}) => {
  await login(page);
  await ensureSessionOpen(page);
  await expect(page.getByTestId('status-bar')).toContainText('Session n°');

  await page.getByTestId('product-search').fill('stylo');
  const tiles = page.getByTestId('product-tile');
  await expect(tiles.first()).toBeVisible();
  await tiles.filter({ hasText: 'BIC Cristal' }).first().click();

  const line = page.getByTestId('cart-line').first();
  await expect(line).toContainText('BIC Cristal');
  await expect(page.getByTestId('cart-total')).toHaveText(/1,20/);

  // Remise 10 % via le dialogue de ligne.
  await line.getByRole('button', { name: 'Remise' }).click();
  await page.getByRole('button', { name: '10 %' }).click();
  await page.getByTestId('apply-discount').click();
  await expect(line).toContainText('−10 %');
  await expect(page.getByTestId('cart-total')).toHaveText(/1,08/);

  // Encaissement CB (pont simulé : approuvé).
  await page.getByTestId('checkout-button').click();
  await expect(page.getByTestId('payment-sheet')).toBeVisible();
  await expect(page.getByTestId('remaining')).toHaveText(/1,08/);
  await page.getByTestId('pay-cb').click();
  await expect(page.getByTestId('payment-list')).toContainText('Carte bancaire');
  await expect(page.getByTestId('remaining')).toHaveText(/0,00/);
  await page.getByTestId('validate-payment').click();

  await expect(page.getByTestId('checkout-success')).toBeVisible();
  await expect(page.getByTestId('ticket-code')).toHaveText(/^T-\d{4}-\d{6}$/);
  await expect(page.getByTestId('receipt-preview')).toContainText('TOTAL TTC');

  // Retour automatique au panier vide après 3 s.
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });
  await expect(page.getByTestId('cart-line')).toHaveCount(0);
});

test('remboursement depuis l’historique', async ({ page }) => {
  await login(page);
  await ensureSessionOpen(page);

  // Une vente en espèces à rembourser.
  await page.getByTestId('product-search').fill('cahier');
  await page.getByTestId('product-tile').first().click();
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cash').click();
  await page.getByTestId('cash-shortcut-500').click();
  await expect(page.getByTestId('cash-change')).toHaveText(/2,55/);
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  const soldCode = await page.getByTestId('ticket-code').textContent();
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });

  // Historique → détail → Rembourser.
  await page.getByRole('link', { name: 'Historique' }).click();
  await expect(page.getByTestId('history-page')).toBeVisible();
  const row = page
    .getByTestId('history-row')
    .filter({ hasText: soldCode ?? 'T-' })
    .first();
  await row.click();
  await expect(page.getByTestId('ticket-detail')).toContainText('DUPLICATA');
  await page.getByTestId('refund-button').click();

  await page.getByTestId('refund-plus').first().click();
  await expect(page.getByTestId('refund-qty').first()).toHaveText('1');
  await expect(page.getByTestId('refund-total')).toHaveText(/2,45/);
  await expect(page.getByTestId('refund-next')).toBeDisabled();
  await page.getByTestId('refund-reason').fill('Article défectueux');
  await page.getByTestId('refund-next').click();

  await expect(page.getByTestId('payment-sheet')).toBeVisible();
  await expect(page.getByTestId('remaining')).toHaveText(/2,45/);
  await page.getByTestId('pay-cash').click();
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-success')).toContainText('Remboursement enregistré');
  await expect(page.getByTestId('ticket-code')).toHaveText(/^T-\d{4}-\d{6}$/);
  await expect(page.getByTestId('checkout-success').getByTestId('receipt-preview')).toContainText(
    'REMBOURSEMENT',
  );
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });

  // Le remboursement apparaît dans la liste du jour.
  await expect(
    page.getByTestId('history-row').filter({ hasText: 'Remboursement' }).first(),
  ).toBeVisible();
});
