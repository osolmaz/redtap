# redtap

## Alpha state policy

redtap changes the current schema in place while the project is in alpha.

Keep `v2/log` and the current segment schema. Change control documents, storage keys, and public contracts directly. Add no compatibility reader, migration shim, dual read, dual write, alias, deprecated path, or feature flag.

Remove the superseded implementation in the same change.

When installed state or on-disk data has an old shape, fail before mutation with the standard reset instruction. Do not silently reinterpret or delete that state.
