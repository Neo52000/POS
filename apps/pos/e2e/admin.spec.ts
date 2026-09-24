import { expect, test } from '@playwright/test';
import { ensureSessionOpen, login, navLink, resetStorage } from './helpers';

/** Écrans administrateur (lots 5 et 6) en mode mock (`is_pos_admin` = vrai). */

test.beforeEach(async ({ page }) => {
  await resetStorage(page);
});

test('archives NF525 : génération du mois précédent puis liste', async ({ page }) => {
  await login(page);
  await ensureSessionOpen(page);
  await navLink(page, 'Réglages').click();
  const section = page.getByTestId('archives-section');
  await expect(section).toBeVisible();
  await expect(section.getByTestId('archive-row')).toHaveCount(0);
  await page.getByTestId('archive-generate').click();
  await expect(section.getByTestId('archive-row')).toHaveCount(1);
  await expect(section.getByTestId('archive-row').first()).toContainText('TEST-01');
  // Deuxième génération : archive existante, pas de doublon.
  await page.getByTestId('archive-generate').click();
  await expect(page.getByText('1 déjà existante(s)').first()).toBeVisible();
  await expect(section.getByTestId('archive-row')).toHaveCount(1);
});

test('inventaire : comptage, lot persistant, envoi et confirmation', async ({ page }) => {
  await login(page);
  await ensureSessionOpen(page);
  await navLink(page, 'Inventaire').click();
  await expect(page.getByTestId('inventory-page')).toBeVisible();

  await page.getByTestId('inventory-search').fill('cahier');
  await page.getByTestId('inventory-result').first().click();
  await expect(page.getByTestId('inventory-stock')).toHaveText('15');
  const pad = page.getByRole('group', { name: 'Pavé numérique' });
  await pad.getByRole('button', { name: '1', exact: true }).click();
  await pad.getByRole('button', { name: '2', exact: true }).click();
  await expect(page.getByTestId('inventory-counted')).toHaveText('12');
  await page.getByTestId('inventory-add').click();
  await expect(page.getByTestId('inventory-line')).toHaveCount(1);
  await expect(page.getByTestId('inventory-line').first()).toContainText('-3');

  // Le lot survit au rechargement (Dexie).
  await page.reload();
  await expect(page.getByTestId('inventory-line')).toHaveCount(1);

  await page.getByTestId('inventory-send').click();
  await expect(page.getByTestId('inventory-line')).toHaveCount(0);
  await expect(page.getByTestId('inventory-confirmed')).toContainText('15 → 12');

  // Le stock catalogue reflète le comptage.
  await page.getByTestId('inventory-search').fill('cahier');
  await expect(page.getByTestId('inventory-result').first()).toContainText('stock 12');
});
