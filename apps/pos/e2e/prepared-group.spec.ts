import { expect, test } from '@playwright/test';
import { ensureSessionOpen, login, resetStorage } from './helpers';

/**
 * Lot préparé au back-office (mock : BL + commande web de la Mairie, facture demandée) :
 * présélectionné en caisse, « Encaisser le lot » l'ajoute au panier, la case facture est
 * pré-cochée, un seul ticket règle les deux documents.
 */
test.beforeEach(async ({ page }) => {
  await resetStorage(page);
});

test('client pro : lot préparé au back-office encaissé sur un ticket, facture pré-cochée', async ({
  page,
}) => {
  await login(page);
  await ensureSessionOpen(page);

  await page.getByTestId('customer-button').click();
  await page.getByTestId('customer-search-input').fill('Mairie');
  await page.getByTestId('customer-result').first().click();
  await page.getByTestId('orders-button').click();

  await expect(page.getByTestId('prepared-group')).toContainText('2 document(s)');
  await expect(page.getByTestId('prepared-group')).toContainText('facture demandée');
  await expect(page.getByTestId('document-BL-2026-00012')).toBeChecked();
  await expect(page.getByTestId('document-CO-2026-00529')).toBeChecked();
  await expect(page.getByTestId('document-CO-2026-00530')).not.toBeChecked();
  await page.getByTestId('import-prepared-group').click();

  await expect(page.getByTestId('cart-line').filter({ hasText: 'Frais de port' })).toHaveCount(1);

  await page.getByTestId('checkout-button').click();
  await expect(page.getByTestId('payment-sheet')).toBeVisible();
  await expect(page.getByTestId('invoice-requested')).toBeChecked();
  await page.getByTestId('pay-cb').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-success')).toBeVisible();

  // Reste la commande ERP hors lot ; plus de lot proposé.
  await page.getByTestId('close-success').click();
  await page.getByTestId('customer-button').click();
  await page.getByTestId('customer-search-input').fill('Mairie');
  await page.getByTestId('customer-result').first().click();
  await page.getByTestId('orders-button').click();
  await expect(page.getByTestId('document-CO-2026-00530')).toBeVisible();
  await expect(page.getByTestId('prepared-group')).toHaveCount(0);
});
