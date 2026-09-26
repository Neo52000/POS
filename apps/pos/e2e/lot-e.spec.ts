import { expect, test } from '@playwright/test';
import { ensureSessionOpen, login, navLink, resetStorage } from './helpers';

/** Remise globale, garde-fous de clôture Z et écran client (mode mock). */

test.beforeEach(async ({ page }) => {
  await resetStorage(page);
  await login(page);
  await ensureSessionOpen(page);
});

test('remise globale : max(remise ligne, globale) puis encaissement', async ({ page }) => {
  await page.getByTestId('product-search').fill('stylo');
  await page.getByTestId('product-tile').filter({ hasText: 'BIC Cristal' }).first().click();
  await page.getByTestId('product-search').fill('petit prince');
  await page.getByTestId('product-tile').filter({ hasText: 'Petit Prince' }).first().click();
  // BIC : remise ligne 15 %.
  const bic = page.getByTestId('cart-line').filter({ hasText: 'BIC' });
  await bic.getByRole('button', { name: 'Remise' }).click();
  await page.getByRole('button', { name: '15 %' }).click();
  await page.getByTestId('apply-discount').click();
  await expect(page.getByTestId('cart-total')).toHaveText(/8,92/); // 1,02 + 7,90

  // Remise globale 10 % (F6) : le livre passe à −10 %, le BIC garde ses 15 %.
  await page.getByTestId('product-search').fill('');
  await page.keyboard.press('F6');
  await page.getByTestId('global-discount-input').fill('10');
  await page.getByTestId('apply-global-discount').click();
  await expect(page.getByTestId('cart-total')).toHaveText(/8,13/); // 1,02 + 7,11
  await expect(page.getByTestId('global-discount-amount')).toHaveText(/0,79/);
  await expect(bic).toContainText('−15 %');
  await expect(page.getByTestId('cart-line').filter({ hasText: 'Petit Prince' })).toContainText(
    '−10 %',
  );

  await page.getByTestId('checkout-button').click();
  await expect(page.getByTestId('remaining')).toHaveText(/8,13/);
  await page.getByTestId('pay-cb').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('receipt-preview')).toContainText('-10 %');
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });
  // Panier vidé : la remise globale ne se reporte pas sur la vente suivante.
  await expect(page.getByTestId('global-discount')).toHaveCount(0);
});

test('clôture Z : ticket en attente averti, encaissement interrompu bloquant', async ({ page }) => {
  // Ticket en attente : simple avertissement.
  await page.getByTestId('product-search').fill('stylo');
  await page.getByTestId('product-tile').filter({ hasText: 'BIC Cristal' }).first().click();
  await page.getByTestId('park-cart').click();
  await navLink(page, 'Caisse').click();
  await expect(page.getByTestId('closing-parked-warning')).toContainText('1 ticket(s)');
  await expect(page.getByTestId('close-session-button')).toBeEnabled();

  // CB débitée puis coupure : le Z est bloqué.
  await navLink(page, 'Vente').click();
  await page.getByTestId('product-search').fill('cahier');
  await page.getByTestId('product-tile').filter({ hasText: 'Cahier' }).first().click();
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cb').click();
  await expect(page.getByTestId('payment-list')).toContainText('Carte bancaire');
  await page.reload();
  await expect(page.getByTestId('draft-banner')).toBeVisible();
  // Panier vidé : seul le brouillon (CB débitée) bloque encore le Z.
  await page.getByTestId('clear-cart').click();
  await page.getByTestId('confirm-action').click();
  await navLink(page, 'Caisse').click();
  await expect(page.getByTestId('closing-cart-blocked')).toHaveCount(0);
  await expect(page.getByTestId('closing-draft-blocked')).toContainText('CB déjà débitée : 2,45');
  await expect(page.getByTestId('close-session-button')).toBeDisabled();

  // Abandon tracé depuis la vente : le Z redevient possible.
  await navLink(page, 'Vente').click();
  await page.getByTestId('draft-abandon').click();
  await page.getByTestId('confirm-action').click();
  await expect(page.getByTestId('draft-banner')).toHaveCount(0);
  await navLink(page, 'Caisse').click();
  await expect(page.getByTestId('closing-draft-blocked')).toHaveCount(0);
  await expect(page.getByTestId('close-session-button')).toBeEnabled();
});

test('écran client : panier, reste à payer, rendu monnaie', async ({ page, context }) => {
  const display = await context.newPage();
  await display.goto('/display');
  await expect(display.getByTestId('customer-display')).toHaveAttribute('data-state', 'idle');

  await page.getByTestId('product-search').fill('cahier');
  await page.getByTestId('product-tile').filter({ hasText: 'Cahier' }).first().click();
  await expect(display.getByTestId('display-total')).toHaveText(/2,45/);

  await page.getByTestId('checkout-button').click();
  await expect(display.getByTestId('display-remaining')).toHaveText(/2,45/);
  await page.getByTestId('pay-cash').click();
  await page.getByTestId('cash-shortcut-500').click();
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  await expect(display.getByTestId('display-change')).toHaveText(/2,55/);
  // Fermeture de la feuille : le remerciement reste affiché (pas d'écrasement par l'accueil).
  await page.getByTestId('close-success').click();
  await expect(display.getByTestId('display-change')).toBeVisible();

  // Un écran ouvert en cours de vente reçoit l'état courant.
  await page.getByTestId('product-search').fill('stylo');
  await page.getByTestId('product-tile').filter({ hasText: 'BIC Cristal' }).first().click();
  const late = await context.newPage();
  await late.goto('/display');
  await expect(late.getByTestId('display-total')).toHaveText(/1,20/);
});

test('KPI du jour : météo et indicateurs sur l’historique et la clôture', async ({ page }) => {
  await page.getByTestId('product-search').fill('cahier');
  await page.getByTestId('product-tile').filter({ hasText: 'Cahier' }).first().click();
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cb').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });

  await navLink(page, 'Historique').click();
  const strip = page.getByTestId('day-kpi');
  await expect(strip.getByTestId('kpi-weather')).toContainText('Pluie · 9° / 16°');
  await expect(strip.getByTestId('kpi-net')).toHaveText(/2,45/);
  await expect(strip.getByTestId('kpi-tickets')).toHaveText('1');
  await expect(strip.getByTestId('kpi-basket')).toHaveText(/2,45/);

  await navLink(page, 'Caisse').click();
  await expect(page.getByTestId('close-session').getByTestId('kpi-tickets')).toHaveText('1');
});
