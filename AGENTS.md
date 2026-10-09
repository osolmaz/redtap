# redtap

## Alpha compatibility policy

redtap is in alpha. Until the repository explicitly leaves alpha:

- Do not preserve backward compatibility unless the user explicitly requires it for a task.
- Change persisted schemas and public contracts in place. Keep their current version identifiers.
- Do not add `v2` schemas, compatibility readers, migration shims, dual reads, dual writes, aliases,
  deprecated paths, or feature flags only to support older alpha state.
- Remove the superseded implementation in the same change.
- If old local state is incompatible, fail with a clear reset instruction. Do not silently
  reinterpret or delete that state.
