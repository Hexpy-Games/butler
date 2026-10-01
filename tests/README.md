# tests

`tests/` contains Butler's automated review gates. Tests are organized around
product contracts: CLI, transport, runtime, memory, context, reliability,
search, tasks, installer, release packaging, and native purge constraints.

## Key Areas

- `unit/`: Bun unit and integration-style tests, plus shell gates.
- `smoke/`: deterministic smoke scripts that exercise product integration
  paths outside the unit runner.
- `live/`: optional live validation scripts that may require model credentials,
  network access, or longer runtimes.
- `managed-bun-runtime.test.sh`: managed runtime install/repair gate.
- `native-purge-gate.sh`: native product purge and documentation gate.

## Boundaries

Tests should assert real product contracts, not only mocks. Prefer isolated
`BUTLER_HOME` and `BUTLER_DATA` fixtures for stateful behavior, and avoid
storing raw private data in fixtures or snapshots.

Tests never touch the owner's real `~/.butler`. The Bun preload
`support/isolated-user-data.ts` gives every test process a private `HOME`,
`BUTLER_DATA` and XDG dirs (and passes them to spawned children); the Rust
E2E harness does the same for the agent it starts, and CI fails a run that
leaves anything under the runner's `~/.butler`.

## Related Specs

- `SPEC-BUTLER-CLI` - Butler CLI
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
