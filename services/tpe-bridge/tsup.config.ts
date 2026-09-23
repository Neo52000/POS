import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'tpe-sim': 'simulator/tpe-sim.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  /** `@pos/core` est un paquet de workspace : on l'inclut dans le bundle pour un déploiement autonome. */
  noExternal: ['@pos/core'],
});
