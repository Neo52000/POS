import { expect, test } from '@playwright/test';
import { ensureSessionOpen, login, navLink, resetStorage } from './helpers';

/** Historique : consultation des jours précédents clôturés (Z journalier). */

const DAY_MS = 86_400_000;
const isoParis = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

test('jour clôturé de la veille : sélection, tickets, badge Z, retour à aujourd’hui', async ({
  page,
}) => {
  await resetStorage(page);
  await login(page);
  await ensureSessionOpen(page);

  // Une vente puis la clôture Z.
  await page.getByTestId('product-search').fill('cahier');
  await page.getByTestId('product-tile').filter({ hasText: 'Cahier' }).first().click();
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cash').click();
  await page.getByTestId('cash-shortcut-500').click();
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  const code = (await page.getByTestId('ticket-code').textContent()) ?? '';
  await page.getByTestId('close-success').click();
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });
  await navLink(page, 'Caisse').click();
  await page.getByTestId('close-session-button').click();
  await expect(page.getByTestId('closing-result')).toBeVisible();

  // Données du mock décalées d'un jour : la vente et le Z deviennent ceux de la veille.
  const yesterday = isoParis(new Date(Date.now() - DAY_MS));
  await page.evaluate(
    ({ day, yesterday }) => {
      const key = 'pos.mock.state.v1';
      const st = JSON.parse(localStorage.getItem(key) ?? '{}') as {
        transactions: Array<{ transaction: { business_date: string; business_at: string } }>;
        closings: Array<{ period_start: string; period_end: string }>;
      };
      const shift = (iso: string): string => new Date(Date.parse(iso) - day).toISOString();
      for (const t of st.transactions) {
        t.transaction.business_date = yesterday;
        t.transaction.business_at = shift(t.transaction.business_at);
      }
      for (const c of st.closings) {
        c.period_start = shift(c.period_start);
        c.period_end = shift(c.period_end);
      }
      localStorage.setItem(key, JSON.stringify(st));
    },
    { day: DAY_MS, yesterday },
  );
  await page.reload();

  await navLink(page, 'Historique').click();
  await expect(page.getByTestId('history-page')).toBeVisible();
  // Aujourd'hui : plus aucun ticket.
  await expect(page.getByText('Aucun ticket aujourd’hui.')).toBeVisible();
  await expect(page.getByTestId('history-day-next')).toBeDisabled();

  // ‹ : jour clôturé précédent.
  await page.getByTestId('history-day-prev').click();
  await expect(page.getByTestId('history-day-select')).toHaveValue(`nf525:${yesterday}`);
  await expect(page.getByTestId('history-day-closed')).toContainText('Clôturé · Z n°1');
  await expect(page.getByTestId('history-row').filter({ hasText: code })).toBeVisible();
  await expect(page.getByTestId('kpi-tickets')).toHaveText('1');
  await expect(page.getByTestId('kpi-weather')).toHaveCount(0);

  // Détail et duplicata restent disponibles.
  await page.getByTestId('history-row').filter({ hasText: code }).click();
  await expect(page.getByTestId('ticket-detail')).toContainText('DUPLICATA');

  // › : retour à aujourd'hui.
  await page.getByTestId('history-day-next').click();
  await expect(page.getByText('Aucun ticket aujourd’hui.')).toBeVisible();
  await expect(page.getByTestId('history-day-closed')).toHaveCount(0);
});

test('archive Shopify POS : jours avant bascule en consultation seule, hors fiscal', async ({
  page,
}) => {
  await resetStorage(page);
  await login(page);
  await ensureSessionOpen(page);
  await navLink(page, 'Historique').click();
  await expect(page.getByTestId('history-page')).toBeVisible();

  // ‹ depuis aujourd'hui (aucun Z) : premier jour Shopify POS de l'archive.
  await page.getByTestId('history-day-prev').click();
  await expect(page.getByTestId('history-day-select')).toHaveValue('shopify:2026-10-31');
  await expect(page.getByTestId('shopify-notice')).toContainText('hors journal fiscal');
  await expect(page.getByTestId('history-day-shopify')).toBeVisible();
  await expect(page.getByTestId('shopify-row')).toHaveCount(2);
  await expect(page.getByTestId('kpi-net')).toHaveText(/19,59/);
  await expect(page.getByTestId('kpi-tickets')).toHaveText('2');

  // Détail d'une commande : lignes, sans duplicata ni remboursement.
  await page.getByTestId('shopify-row').filter({ hasText: '#1392' }).click();
  await expect(page.getByTestId('shopify-order-detail')).toContainText('Stylo BIC Cristal');
  await expect(page.getByTestId('reprint-button')).toHaveCount(0);
  await expect(page.getByTestId('refund-button')).toHaveCount(0);

  // Jour précédent : commande remboursée listée mais hors CA.
  await page.getByTestId('history-day-prev').click();
  await expect(page.getByTestId('history-day-select')).toHaveValue('shopify:2026-10-30');
  await expect(page.getByTestId('shopify-row')).toHaveCount(2);
  await expect(page.getByTestId('shopify-row').filter({ hasText: 'Remboursée' })).toHaveCount(1);
  await expect(page.getByTestId('kpi-net')).toHaveText(/12,00/);

  // Retour à aujourd'hui : historique NF525 normal.
  await page.getByRole('button', { name: 'Aujourd’hui' }).click();
  await expect(page.getByText('Aucun ticket aujourd’hui.')).toBeVisible();
  await expect(page.getByTestId('shopify-notice')).toHaveCount(0);
});
