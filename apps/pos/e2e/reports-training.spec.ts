import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureSessionOpen, login, navLink, resetStorage } from './helpers';

/**
 * Lecture X, clôtures Z1 / Z2, mode formation, thème clair et mode tactile (mode mock).
 * `DEMO_SCREENSHOTS=1` enregistre en plus des captures dans `docs/screenshots/`.
 */
const OUT = path.resolve(process.cwd(), '../../docs/screenshots');

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.DEMO_SCREENSHOTS) return;
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function sellCash(page: Page, query: string): Promise<void> {
  await page.getByTestId('product-search').fill(query);
  await page.getByTestId('product-tile').first().click();
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cash').click();
  await page.getByTestId('cash-shortcut-500').click();
  await page.getByTestId('cash-confirm').click();
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-success')).toBeVisible();
  await page.getByTestId('close-success').click();
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });
}

/** Mock : ajoute un Z1 daté du mois précédent (pour établir un Z2). */
async function seedPreviousMonthDaily(page: Page): Promise<void> {
  await page.evaluate(() => {
    const key = 'pos.mock.state.v1';
    const st = JSON.parse(localStorage.getItem(key) ?? '{}') as { closings?: unknown[] };
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 10, 9);
    const end = new Date(now.getFullYear(), now.getMonth() - 1, 10, 19);
    const closings = st.closings ?? [];
    closings.unshift({
      id: '66666666-6666-4666-8666-999999999999',
      register_id: '11111111-1111-4111-8111-111111111111',
      closing_number: 0,
      period_type: 'daily',
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      session_id: null,
      txn_count: 12,
      first_ticket_number: 1,
      last_ticket_number: 12,
      total_ht_cents: 20000,
      total_vat_cents: 4000,
      total_ttc_cents: 24000,
      vat_breakdown: [{ rate: '20.00', base_ht_cents: 20000, vat_cents: 4000, ttc_cents: 24000 }],
      payments_breakdown: [
        { method: 'cash', amount_cents: 9000, count: 5 },
        { method: 'cb', amount_cents: 15000, count: 7 },
      ],
      refunds_ttc_cents: 0,
      grand_total_perpetual_cents: 24000,
      hash: 'seedseedseedseedseedseedseedseed',
      created_at: end.toISOString(),
    });
    localStorage.setItem(key, JSON.stringify({ ...st, closings }));
  });
}

test.beforeEach(async ({ page }) => {
  await resetStorage(page);
});

test('lecture X sans remise à zéro, Z1 à la clôture, Z2 du mois précédent', async ({ page }) => {
  await login(page);
  await ensureSessionOpen(page);
  await sellCash(page, 'cahier');

  // Lecture X : chiffres de la session, non fiscale, tracée.
  await navLink(page, 'Rapports').click();
  await expect(page.getByTestId('reports-page')).toBeVisible();
  await page.getByTestId('x-read').click();
  const x = page.getByTestId('report-preview');
  await expect(x).toHaveAttribute('data-kind', 'X');
  await expect(x).toContainText('LECTURE X');
  await expect(x).toContainText('Document non fiscal');
  await expect(x).toContainText('Tickets');
  await expect(x).toContainText('Espèces attendues');
  await expect(x).toContainText('seul le Z fait foi');
  await page.getByTestId('report-print').click();
  await shot(page, 'rapports-1-lecture-x');
  const printed = await page.evaluate(
    () => (globalThis as { __posMockPrinted?: Array<{ kind?: string }> }).__posMockPrinted ?? [],
  );
  expect(printed.at(-1)?.kind).toBe('X');
  // Une lecture X n'a rien clôturé : aucune clôture Z1.
  await page.getByTestId('report-tab-z1').click();
  await expect(page.getByTestId('closings-empty')).toBeVisible();

  // Clôture Z1 : rapport imprimé automatiquement, visible dans Rapports.
  await navLink(page, 'Caisse').click();
  await page.getByTestId('close-session-button').click();
  await expect(page.getByTestId('closing-result')).toBeVisible();
  await expect(page.getByTestId('report-preview')).toContainText('CLÔTURE JOURNALIÈRE Z1');
  await expect(page.getByTestId('report-preview')).toContainText('Grand total perpétuel');
  await navLink(page, 'Rapports').click();
  await page.getByTestId('report-tab-z1').click();
  await expect(page.getByTestId('closing-item')).toHaveCount(1);
  await expect(page.getByTestId('report-preview')).toContainText('DUPLICATA');
  await shot(page, 'rapports-2-z1');

  // Z2 : aucun Z1 le mois dernier → refus explicite.
  await page.getByTestId('report-tab-z2').click();
  await page.getByTestId('close-monthly').click();
  await expect(page.getByText(/rien à clôturer/).first()).toBeVisible();

  // Avec un Z1 le mois précédent : Z2 établi, puis idempotent.
  await seedPreviousMonthDaily(page);
  await page.reload();
  await page.getByTestId('report-tab-z2').click();
  await page.getByTestId('close-monthly').click();
  await expect(page.getByTestId('closing-item')).toHaveCount(1);
  const z2 = page.getByTestId('report-preview');
  await expect(z2).toHaveAttribute('data-kind', 'Z2');
  await expect(z2).toContainText('CLÔTURE MENSUELLE Z2');
  await expect(z2).toContainText('240,00');
  await shot(page, 'rapports-3-z2');
  await page.getByTestId('close-monthly').click();
  await expect(page.getByText(/déjà établi/).first()).toBeVisible();
  await expect(page.getByTestId('closing-item')).toHaveCount(1);
});

test('mode formation : vente fictive, TPE simulé, rien enregistré, X de formation', async ({
  page,
}) => {
  await login(page);
  await ensureSessionOpen(page);
  const before = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('pos.mock.state.v1') ?? '{}') as {
      transactions?: unknown[];
    };
    return st.transactions?.length ?? 0;
  });

  await navLink(page, 'Réglages').click();
  await page.getByTestId('training-start').click();
  await page.getByRole('button', { name: 'Démarrer la formation' }).click();
  await expect(page.getByTestId('training-banner')).toBeVisible();
  await expect(page.getByTestId('sale-page')).toBeVisible();

  // Vente CB (TPE simulé) : ticket FORM-0001, jamais envoyé au serveur.
  await page.getByTestId('product-search').fill('stylo');
  await page.getByTestId('product-tile').first().click();
  await page.getByTestId('checkout-button').click();
  await page.getByTestId('pay-cb').click();
  await expect(page.getByTestId('remaining')).toHaveText(/0,00/);
  await page.getByTestId('validate-payment').click();
  await expect(page.getByTestId('checkout-success')).toContainText('Vente de formation');
  await expect(page.getByTestId('ticket-code')).toHaveText('FORM-0001');
  await expect(page.getByTestId('receipt-preview')).toContainText('FORMATION');
  await shot(page, 'formation-1-vente');
  await expect(page.getByTestId('payment-sheet')).toBeHidden({ timeout: 8000 });

  const state = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('pos.mock.state.v1') ?? '{}') as {
      transactions?: unknown[];
      events?: Array<{ type: string }>;
    };
    return { txns: st.transactions?.length ?? 0, events: (st.events ?? []).map((e) => e.type) };
  });
  expect(state.txns).toBe(before);
  expect(state.events).toContain('training_mode_start');

  // Z1 impossible en formation ; X de formation calculée localement.
  await navLink(page, 'Caisse').click();
  await expect(page.getByTestId('closing-training-blocked')).toBeVisible();
  await expect(page.getByTestId('close-session-button')).toBeDisabled();
  await navLink(page, 'Rapports').click();
  await page.getByTestId('x-read').click();
  await expect(page.getByTestId('report-training')).toBeVisible();
  await expect(page.getByTestId('report-preview')).toContainText('MODE FORMATION');
  await shot(page, 'formation-2-lecture-x');

  await page.getByTestId('training-exit').click();
  await expect(page.getByTestId('training-banner')).toBeHidden();
  const events = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('pos.mock.state.v1') ?? '{}') as {
      events?: Array<{ type: string }>;
    };
    return (st.events ?? []).map((e) => e.type);
  });
  expect(events).toContain('training_mode_end');
});

test('thème clair et mode tactile avec clavier virtuel', async ({ page }) => {
  await login(page);
  await ensureSessionOpen(page);
  await navLink(page, 'Réglages').click();

  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByTestId('touch-mode').click();
  await expect(page.locator('html')).toHaveAttribute('data-touch', 'on');
  await shot(page, 'affichage-1-reglages-clair');

  // Le thème est appliqué avant le rendu au rechargement (pas de flash sombre).
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await navLink(page, 'Vente').click();
  const search = page.getByTestId('product-search');
  await search.click();
  const vk = page.getByTestId('virtual-keyboard');
  await expect(vk).toBeVisible();
  await expect(search).toHaveAttribute('inputmode', 'none');
  for (const k of ['s', 't', 'y', 'l', 'o']) await vk.getByTestId(`vk-${k}`).click();
  await expect(search).toHaveValue('stylo');
  await expect(page.getByTestId('product-tile').first()).toBeVisible();
  await shot(page, 'affichage-2-tactile-clavier');
  await vk.getByTestId('vk-close').click();
  await expect(vk).toBeHidden();

  // Pavé à l'écran existant : pas de clavier virtuel en double.
  await page.getByTestId('product-tile').first().click();
  await page.getByTestId('cart-line').first().getByTestId('line-qty').click();
  await expect(page.getByTestId('qty-input')).toBeVisible();
  await expect(vk).toBeHidden();
});
