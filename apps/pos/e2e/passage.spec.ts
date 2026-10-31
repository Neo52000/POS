import { expect, test } from '@playwright/test';
import { ensureSessionOpen, login, resetStorage } from './helpers';

/**
 * Client de passage (mock) : recherche par téléphone, transfert de sa commande ERP, encaissement.
 * Le ticket porte la fiche « Client passage » ; le nom figure sur le ticket (snapshot).
 */
test.beforeEach(async ({ page }) => {
  await resetStorage(page);
});

test('client de passage : recherche par téléphone → commande transférée → encaissement', async ({
  page,
}) => {
  await login(page);
  await ensureSessionOpen(page);

  await page.getByTestId('customer-button').click();
  await page.getByTestId('customer-tab-passage').click();
  await page.getByTestId('passage-search-input').fill('06 12 34');
  const result = page.getByTestId('passage-result');
  await expect(result).toContainText('Mme Dupont');
  await expect(result).toContainText('1 commande(s)');
  await result.click();

  await expect(page.getByTestId('customer-badge-name')).toHaveText('Mme Dupont');
  await expect(page.getByTestId('customer-badge')).toContainText('Passage');

  await page.getByTestId('orders-button').click();
  await page.getByTestId('import-order').first().click();
  await expect(page.getByTestId('cart-line').first()).toContainText('Cahier Clairefontaine');

  await page.getByTestId('checkout-button').click();
  await expect(page.getByTestId('payment-sheet')).toBeVisible();
  await page.getByTestId('pay-cb').click();
  await page.getByTestId('validate-payment').click();

  await expect(page.getByTestId('checkout-success')).toBeVisible();
  await expect(page.getByTestId('receipt-preview')).toContainText('Passage — Mme Dupont');
});

test('client de passage : création nom + téléphone puis rattachement', async ({ page }) => {
  await login(page);
  await ensureSessionOpen(page);

  await page.getByTestId('customer-button').click();
  await page.getByTestId('customer-tab-passage').click();
  await page.getByTestId('passage-name-input').fill('M. Leroy');
  await page.getByTestId('passage-phone-input').fill('07 00 11 22 33');
  await page.getByTestId('passage-create').click();

  await expect(page.getByTestId('customer-badge-name')).toHaveText('M. Leroy');
  await expect(page.getByTestId('customer-badge')).toContainText('07 00 11 22 33');
  await expect(page.getByTestId('orders-button')).toHaveCount(0);
});
