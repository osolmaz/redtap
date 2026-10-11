import { defineConfig } from 'vitest/config';

export default defineConfig({
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
