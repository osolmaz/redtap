import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// the vendored hub lives outside src; resolve the source-relative specifier
// onto the physical bundle so tests can mock it
const vendoredHub = fileURLToPath(new URL('./extension/lib/vendor/index.mjs', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: './vendor/index.mjs', replacement: vendoredHub }],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['extension/src/**/*.ts', 'builder/src/**/*.ts'],
      exclude: [
        // chrome entry points: they run only inside the browser and are
        // exercised by the live pipeline, not unit tests
        'extension/src/background.ts',
        'extension/src/content.ts',
        'extension/src/options.ts',
        'extension/src/popup.ts',
        // deployment scripts that run only on bob's machine
        'builder/src/ingest-daemon.ts',
        'builder/src/build-site.ts',
        'builder/src/parity-check.ts',
        'builder/src/check-base-actions.ts',
        'builder/src/serve.ts',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 85,
      },
    },
  },
});
