import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as {
  version: string;
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const e2eMock = env.VITE_E2E_MOCK === '1';
  const hostOf = (u: string | undefined): string => {
    try {
      return u ? new URL(u).host : '';
    } catch {
      return '';
    }
  };
  // Projets Supabase « Pos » et « ma-papeterie » (catalogue) : jamais mis en cache.
  const supabaseHosts = [
    hostOf(env.VITE_SUPABASE_URL),
    hostOf(env.VITE_CATALOG_SUPABASE_URL),
  ].filter(Boolean);

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        // Le service worker est désactivé en mode e2e (mocks in-memory, pas de cache).
        disable: e2eMock,
        includeAssets: ['icons/icon.svg'],
        manifest: {
          name: 'Ma Papeterie POS',
          short_name: 'Papeterie POS',
          description: 'Caisse NF525 — Ma Papeterie (Chaumont)',
          lang: 'fr',
          start_url: '/',
          scope: '/',
          display: 'fullscreen',
          orientation: 'landscape',
          background_color: '#0a0a0f',
          theme_color: '#0a0a0f',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
            { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
          ],
        },
        workbox: {
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/functions\//, /^\/rest\//, /^\/auth\//],
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          runtimeCaching: [
            {
              // Supabase (REST, RPC, auth, Edge Functions) : jamais mis en cache.
              urlPattern: ({ url }) =>
                supabaseHosts.includes(url.host) || url.hostname.endsWith('.supabase.co'),
              handler: 'NetworkOnly',
            },
            {
              urlPattern: ({ url }) =>
                url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com',
              handler: 'CacheFirst',
              options: {
                cacheName: 'pos-fonts',
                expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
    },
  };
});
