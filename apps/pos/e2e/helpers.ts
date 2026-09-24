import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Vide localStorage, sessionStorage et la base IndexedDB de la caisse. */
export async function resetStorage(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('ma-papeterie-pos');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });
}

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill('vendeur@ma-papeterie.fr');
  await page.getByTestId('login-password').fill('secret');
  await page.getByTestId('login-submit').click();
}

export async function ensureSessionOpen(page: Page): Promise<void> {
  // Sans session ouverte, la page de vente redirige vers /closing (ouverture) : on attend l'un ou l'autre.
  const openForm = page.getByTestId('open-session');
  const salePage = page.getByTestId('sale-page');
  await expect(openForm.or(salePage)).toBeVisible();
  if (await openForm.isVisible()) {
    await page.getByTestId('opening-float-input').fill('50');
    await expect(page.getByTestId('opening-float')).toHaveText(/50,00/);
    await page.getByTestId('open-session-button').click();
  }
  await expect(salePage).toBeVisible();
}

/** Onglet de la navigation principale. */
export function navLink(page: Page, name: string | RegExp) {
  return page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('link', { name });
}
