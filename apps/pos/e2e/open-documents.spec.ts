import { expect, test } from '@playwright/test';
import { ensureSessionOpen, login, resetStorage } from './helpers';

/**
 * Client pro appelé (mock) : ses commandes et BL en cours, deux commandes + un BL ajoutés au
 * panier (qui n'est pas vidé), encaissés sur un seul ticket puis retirés de la liste.
 */
test.beforeEach(async ({ page }) => {
  await resetStorage(page);
});

test('client pro : 2 commandes + 1 BL encaissés sur un ticket', async ({ page }) => {
  await login(page);
  await ensureSessionOpen(page);

  await page.getByTestId('customer-button').click();
  await page.getByTestId('customer-search-input').fill('Mairie');
  await page.getByTestId('customer-result').first().click();

  const ordersButton = page.getByTestId('orders-button');
  await expect(ordersButton).toContainText('Commandes / BL en cours (3)');
  await ordersButton.click();
  await page.getByTestId('document-BL-2026-00012').check();
  await page.getByTestId('document-CO-2026-00529').check();
  await page.getByTestId('document-CO-2026-00530').check();
  await page.getByTestId('import-documents').click();

  const lines = page.getByTestId('cart-line');
  await expect(lines).toHaveCount(5);
  await expect(lines.filter({ hasText: 'Ramette papier A4' })).toHaveCount(2);
  await expect(lines.filter({ hasText: 'Frais de port' })).toHaveCount(1);

  await page.getByTestId('checkout-button').click();
  await expect(page.getByTestId('payment-sheet')).toBeVisible();
  await page.getByTestId('pay-cb').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-success')).toBeVisible();

  // Le client est détaché après la vente : on le rappelle, plus rien à encaisser.
  await page.getByTestId('close-success').click();
  await page.getByTestId('customer-button').click();
  await page.getByTestId('customer-search-input').fill('Mairie');
  await page.getByTestId('customer-result').first().click();
  await expect(page.getByTestId('customer-badge')).toBeVisible();
  await expect(page.getByTestId('orders-button')).toHaveCount(0);
});
