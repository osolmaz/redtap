# Vendored: @huggingface/hub

- Source: `@huggingface/hub@2.17.5` `dist/browser/*` (index.mjs + chunk files)
  plus `@huggingface/xetchunk-wasm` `dist/esm/*` (as `xetchunk/`),
  `gearhash-jit` `dist/esm/*` (as `gearhash/`), and
  `@huggingface/blake3-jit` `dist/esm/*` (as `blake3/`).
- Rewrites: bare package specifiers pointed at the vendored relative paths.
- Reason: the MV3 worker needs no bundler; static imports only (dynamic
  import() is disallowed on ServiceWorkerGlobalScope).
- Refresh: re-copy from freshly installed packages and re-apply the rewrites.
