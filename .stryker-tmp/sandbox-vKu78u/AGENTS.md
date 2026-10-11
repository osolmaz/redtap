# redtap

## Commands

Run from the repository root before finishing any change:

```sh
pnpm run check        # prettier --check, eslint, tsc --noEmit, vitest --coverage, extension build
pnpm run mutate       # stryker mutation gate on the v1 log core
pnpm exec slophammer-ts check . --execute
```

Serve locally with `pnpm serve` (HF bucket backend) and build the static
site with `pnpm run build:site`. Tests live in `tests/` and run with vitest.

## Alpha state policy

redtap changes the current schema in place while the project is in alpha.

Keep `v1/log` and the current segment schema. Change control documents, storage keys, and public contracts directly. Add no compatibility reader, migration shim, dual read, dual write, alias, deprecated path, or feature flag.

Remove the superseded implementation in the same change.

When installed state or on-disk data has an old shape, fail before mutation with the standard reset instruction. Do not silently reinterpret or delete that state.
