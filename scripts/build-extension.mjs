// Build the extension: bundle the TS entry points into the manifest's js paths.
// Bundling is required because the runtime imports zod, which is a bare module
// specifier that Chrome cannot resolve natively.
import { build } from 'esbuild';

const common = {
  bundle: true,
  sourcemap: false,
  logLevel: 'info',
  target: 'chrome120',
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['extension/src/background.ts'],
    outfile: 'extension/background.js',
    format: 'esm',
  }),
  build({
    ...common,
    entryPoints: ['extension/src/options.ts'],
    outfile: 'extension/options.js',
    format: 'esm',
  }),
  build({
    ...common,
    entryPoints: ['extension/src/popup.ts'],
    outfile: 'extension/popup.js',
    format: 'esm',
  }),
  // Content scripts load as classic scripts, so they must be IIFE.
  build({
    ...common,
    entryPoints: ['extension/src/content.ts'],
    outfile: 'extension/content.js',
    format: 'iife',
  }),
]);
