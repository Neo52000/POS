import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureSessionOpen, login, navLink, resetStorage } from './helpers';

/** Mode hors ligne (lot 4) en mode mock : interrupteur réseau `pos.mock.offline`. */

async function goOffline(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('pos.mock.offline', '1');
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.getByTestId('connectivity-status')).toContainText('Hors ligne');
}

async function sellCahierCash(page: Page): Promise<string> {
  await page.getByTestId('product-search').fill('cahier');
  await page.getByTestId('product-tile').filter({ hasText: 'Cahier' }).first().click();
  await expect(page.getByTestId('cart-total')).toHaveText(/2,45/);
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cash').click();
  await page.getByTestId('cash-shortcut-500').click();
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-success')).toBeVisible();
  const code = (await page.getByTestId('ticket-code').textContent()) ?? '';
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });
  return code;
}

test.beforeEach(async ({ page }) => {
  await resetStorage(page);
});

test('hors ligne : vente provisoire OFF-…, garde-fous, rejeu au retour du réseau', async ({
  page,
}) => {
  await login(page);
  await ensureSessionOpen(page);

  // Catalogue local synchronisé en arrière-plan après la connexion.
  await navLink(page, /Hors ligne/).click();
  await expect(page.getByTestId('offline-page')).toBeVisible();
  await expect(page.getByTestId('catalog-count')).toHaveText('6');

  // Une vente en ligne, affichée dans l'historique (pour vérifier le blocage du remboursement).
  await navLink(page, 'Vente').click();
  const onlineCode = await sellCahierCash(page);
  expect(onlineCode).toMatch(/^T-\d{4}-\d{6}$/);
  await navLink(page, 'Historique').click();
  await page.getByTestId('history-row').filter({ hasText: onlineCode }).first().click();
  await expect(page.getByTestId('refund-button')).toBeEnabled();

  // Coupure réseau.
  await goOffline(page);
  await expect(page.getByTestId('refund-button')).toBeDisabled();

  // Clôture impossible hors ligne.
  await navLink(page, 'Caisse').click();
  await expect(page.getByTestId('close-session')).toBeVisible();
  await expect(page.getByTestId('closing-offline')).toBeVisible();
  await expect(page.getByTestId('close-session-button')).toBeDisabled();

  // Vente hors ligne en espèces : ticket provisoire.
  await navLink(page, 'Vente').click();
  await page.getByTestId('product-search').fill('cahier');
  await page.getByTestId('product-tile').filter({ hasText: 'Cahier' }).first().click();
  await page.getByTestId('checkout-button').click();
  await expect(page.getByTestId('payment-offline-notice')).toBeVisible();
  await page.getByTestId('pay-cash').click();
  await page.getByTestId('cash-shortcut-500').click();
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-provisional')).toBeVisible();
  await expect(page.getByTestId('ticket-code')).toHaveText(/^OFF-TEST-01-\d{8}-\d{3}$/);
  const provisional = (await page.getByTestId('ticket-code').textContent()) ?? '';
  await expect(page.getByTestId('checkout-success').getByTestId('receipt-preview')).toContainText(
    'TICKET PROVISOIRE',
  );
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });
  await expect(page.getByTestId('cart-line')).toHaveCount(0);
  await expect(page.getByTestId('offline-queue-count')).toContainText('1 en file');
  await expect(page.getByTestId('connectivity-status')).toContainText('1 vente en attente');

  // Z interdite tant que la file n'est pas vide.
  await navLink(page, 'Caisse').click();
  await expect(page.getByTestId('closing-queue-blocked')).toBeVisible();

  // File hors ligne.
  await navLink(page, /Hors ligne/).click();
  const item = page.getByTestId('queue-item');
  await expect(item).toHaveCount(1);
  await expect(item.first()).toContainText(provisional);
  await expect(item.first()).toContainText('En attente');

  // Retour du réseau → « Rejouer maintenant ».
  await page.evaluate(() => localStorage.removeItem('pos.mock.offline'));
  await page.getByTestId('replay-now').click();
  await expect(page.getByTestId('queue-item')).toHaveCount(0);
  await expect(page.getByTestId('queue-empty')).toBeVisible();
  const done = page.getByTestId('queue-item-done').filter({ hasText: provisional });
  await expect(done).toContainText(/T-\d{4}-\d{6}/);
  const serverCode = ((await done.textContent()) ?? '').match(/T-\d{4}-\d{6}/)?.[0] ?? '';
  expect(serverCode).not.toBe(onlineCode);
  await expect(page.getByTestId('connectivity-status')).toContainText('En ligne');
  await expect(page.getByTestId('offline-queue-count')).toHaveCount(0);

  // L'historique affiche le ticket définitif.
  await navLink(page, 'Historique').click();
  await expect(page.getByTestId('history-row').filter({ hasText: serverCode })).toBeVisible();
});

test('hors ligne : échec réseau pendant l’envoi → bascule et ticket provisoire', async ({
  page,
}) => {
  await login(page);
  await ensureSessionOpen(page);
  await navLink(page, /Hors ligne/).click();
  await expect(page.getByTestId('catalog-count')).toHaveText('6');
  await navLink(page, 'Vente').click();

  // Réseau coupé sans événement navigateur : l'échec NETWORK de pos-checkout déclenche la bascule.
  await page.getByTestId('product-search').fill('cahier');
  await page.getByTestId('product-tile').filter({ hasText: 'Cahier' }).first().click();
  await page.evaluate(() => localStorage.setItem('pos.mock.offline', '1'));
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cash').click();
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('ticket-code')).toHaveText(/^OFF-TEST-01-\d{8}-\d{3}$/);
  await expect(page.getByTestId('connectivity-status')).toContainText('Hors ligne');

  // Recherche client indisponible hors ligne.
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });
  await expect(page.getByTestId('customer-button')).toBeDisabled();

  // Retour réseau (événement navigateur) : rejeu automatique.
  await page.evaluate(() => {
    localStorage.removeItem('pos.mock.offline');
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByTestId('offline-queue-count')).toHaveCount(0);
  await expect(page.getByTestId('connectivity-status')).toContainText('En ligne');
});
