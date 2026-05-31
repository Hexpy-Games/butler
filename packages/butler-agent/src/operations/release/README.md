# release

`packages/butler-agent/src/operations/release/` contains the service-owned
release packaging contract. It validates only Butler service metadata, CLI
entrypoint, managed runtime pin, service package files, and private data safety
before a service release is considered shippable.

## Key Files

- `manifest.ts`: service release manifest creation and validation.
- `release-gate.ts`: service-owned release gate entrypoint.

## Boundaries

Service release checks must not inspect app or app-server package internals.
They complement but do not replace full validation, managed runtime checks, app
release gates, and native purge gates.

## Related Specs

- `SPEC-RELEASE-PACKAGING` - Release Packaging
- `SPEC-BUTLER-CLI` - Butler CLI
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
