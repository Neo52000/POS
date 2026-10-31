import { expect, test } from '@playwright/test';
import { ensureSessionOpen, login, resetStorage } from './helpers';

/**
 * Encaissement groupé (mock) : deux commandes non réglées d'un client pro sélectionnées puis
 * regroupées sur un seul ticket (une facture, un encaissement) ; après paiement, elles ne sont
 * plus proposées à l'encaissement.
 */
test.beforeEach(async ({ page }) => {
  await resetStorage(page);
});

test('client pro : sélection de 2 commandes → panier groupé → encaissement → commandes réglées', async ({
  page,
}) => {
  await login(page);
  await ensureSessionOpen(page);

  await page.getByTestId('customer-button').click();
  await page.getByTestId('customer-search-input').fill('Mairie');
  await page.getByTestId('customer-result').first().click();
  await expect(page.getByTestId('customer-badge-name')).toHaveText('Mairie de Chaumont');

  await page.getByTestId('orders-button').click();
  await expect(page.getByTestId('select-order')).toHaveCount(2);
  await expect(page.getByTestId('import-orders-grouped')).toBeDisabled();
  await page.getByTestId('select-all-orders').check();
  await expect(page.getByTestId('grouped-summary')).toHaveText('2 commande(s) · 41,99 € TTC');
  await page.getByTestId('import-orders-grouped').click();

  await expect(page.getByTestId('cart-line')).toHaveCount(5);
  await expect(page.getByTestId('cart-line').nth(3)).toContainText('Cahier Clairefontaine');

  await page.getByTestId('checkout-button').click();
  await expect(page.getByTestId('payment-sheet')).toBeVisible();
  await page.getByTestId('pay-cb').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-success')).toBeVisible();
  await page.getByTestId('close-success').click();

  // Les deux commandes sont réglées : plus proposées à l'encaissement.
  await page.getByTestId('customer-button').click();
  await page.getByTestId('customer-search-input').fill('Mairie');
  await page.getByTestId('customer-result').first().click();
  await expect(page.getByTestId('customer-badge-name')).toHaveText('Mairie de Chaumont');
  await expect(page.getByTestId('orders-button')).toHaveCount(0);
});
