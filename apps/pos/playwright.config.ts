import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * Les tests e2e tournent contre `vite preview` en mode mock (`VITE_E2E_MOCK=1`) :
 * Supabase, Edge Functions et pont TPE sont remplacés par des mocks in-memory.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1366, height: 800 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { ...process.env, VITE_E2E_MOCK: '1', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
  },
});
