import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureSessionOpen, login, resetStorage } from './helpers';

/**
 * Captures de démonstration de l'interface de vente (mode mock).
 * Désactivé par défaut : `DEMO_SCREENSHOTS=1 pnpm exec playwright test demo-screenshots`
 * (`DEMO_PREFIX` pour préfixer les fichiers de `docs/screenshots/`).
 */
const OUT = path.resolve(process.cwd(), '../../docs/screenshots');
const PREFIX = process.env.DEMO_PREFIX ?? 'vente';

test.skip(!process.env.DEMO_SCREENSHOTS, 'captures de démo uniquement à la demande');
test.use({ viewport: { width: 1366, height: 800 } });

/** Attend la fin des animations et masque les notifications éphémères. */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) });
}

async function add(page: Page, q: string, name: RegExp): Promise<void> {
  await page.getByTestId('product-search').fill(q);
  await page.getByTestId('product-tile').filter({ hasText: name }).first().click();
}

test('captures : favoris → panier → paiement → succès → attente → reprise', async ({ page }) => {
  await resetStorage(page);
  await login(page);
  await ensureSessionOpen(page);

  // Favoris épinglés depuis les résultats de recherche.
  for (const [q, name] of [
    ['stylo', /BIC Cristal/],
    ['stylo', /Pilot V5/],
    ['cahier', /Clairefontaine/],
    ['petit prince', /Petit Prince/],
  ] as const) {
    await page.getByTestId('product-search').fill(q);
    await page
      .getByTestId('product-tile')
      .filter({ hasText: name })
      .first()
      .locator('xpath=..')
      .getByTestId('toggle-favorite')
      .click();
  }
  await page.getByTestId('product-search').fill('');
  await expect(page.getByTestId('favorites-grid')).toBeVisible();
  await expect(page.getByText('Session n°1 ouverte')).toBeHidden({ timeout: 15_000 });
  await shot(page, '1-accueil-favoris');

  // Panier : multiplicateur « 3* », remise ligne, livre à 5,5 %.
  await page.getByTestId('product-search').fill('3* cahier');
  await expect(page.getByTestId('qty-multiplier')).toBeVisible();
  await shot(page, '2-multiplicateur');
  await page
    .getByTestId('product-tile')
    .filter({ hasText: /Clairefontaine/ })
    .first()
    .click();
  await add(page, 'stylo', /BIC Cristal/);
  await add(page, 'petit prince', /Petit Prince/);
  const bic = page.getByTestId('cart-line').filter({ hasText: 'BIC' });
  await bic.getByRole('button', { name: 'Remise' }).click();
  await page.getByRole('button', { name: '10 %' }).click();
  await page.getByTestId('apply-discount').click();
  await page.getByTestId('product-search').fill('');
  await shot(page, '3-panier');

  // Feuille de paiement (raccourcis 1 à 5).
  await page.keyboard.press('F12');
  await expect(page.getByTestId('payment-sheet')).toBeVisible();
  await shot(page, '4-paiement');

  // Espèces avec rendu : l'écran de succès reste affiché.
  await page.keyboard.press('2');
  await page.getByTestId('cash-shortcut-2000').click();
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-success')).toBeVisible();
  await shot(page, '5-succes-rendu');
  await page.getByTestId('close-success').click();
  await expect(page.getByTestId('payment-sheet')).toBeHidden();

  // Tickets en attente.
  await add(page, 'stylo', /Lamy/);
  await page.getByTestId('park-cart').click();
  await add(page, 'cahier', /Clairefontaine/);
  await add(page, 'stylo', /Pilot V5/);
  await page.getByTestId('park-cart').click();
  await add(page, 'petit prince', /Petit Prince/);
  await page.getByTestId('product-search').fill('');
  await page.getByTestId('show-parked').click();
  await expect(page.getByTestId('parked-item')).toHaveCount(2);
  await shot(page, '6-attente');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('parked-sheet')).toBeHidden();

  // CB captée puis rechargement : bannière de reprise.
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cb').click();
  await expect(page.getByTestId('payment-list')).toContainText('Carte bancaire');
  await shot(page, '7-cb-verrouillee');
  await page.reload();
  await expect(page.getByTestId('draft-banner')).toBeVisible();
  await shot(page, '8-reprise');
});
