# integrations

`packages/butler-agent/src/integrations/` contains integration-specific support packages. These
packages can hold adapter-adjacent command handlers, registration helpers, and
integration-local utilities, but agent policy, product interfaces, and delivery
contracts remain outside this folder.

## Modules

- `providers/`: model-provider execution, auth, model catalog, and local model
  registration.
- `project-ledger/`: Butler's adapter for the portable Project Ledger CLI.
- `search/`: web search planning, provider selection, and page reading.
- `skills/`: bundled skill catalog loading and selection.
- `telegram/`: Telegram command package and topic helper code.

## Boundaries

Integration packages should not become the source of truth for session routing,
delivery guarantees, or worker state. Those concerns belong to gateway,
transport, and agent work modules.

## Related Specs

- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
