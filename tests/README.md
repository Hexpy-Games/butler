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

## Related Specs

- `SPEC-BUTLER-CLI` - Butler CLI
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
