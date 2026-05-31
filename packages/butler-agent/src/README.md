# Butler Agent Source

`packages/butler-agent/src/` contains Butler's headless agent product code. It
is organized by architecture boundary so the agent core, product interfaces,
external integrations, operational runtime, and test support are easy to
navigate.

## Module Map

- `agent/`: Butler agent core, including turn execution, prompt assembly,
  context, cognition, work orchestration, tools, policy, output contracts, and
  event contracts.
- `interfaces/`: product and process surfaces such as CLI, gateway, MCP
  server/client, and transports.
- `integrations/`: adapters for external capabilities such as model providers,
  Project Ledger, search, skills, and Telegram command integration.
- `operations/`: service supervision, scheduler, health, metrics, install,
  release, and validation-facing runtime support.
- `personalization/`: profile, onboarding, persona, and personalization logic
  that intentionally remains a transitional root until ownership is proven.
- `test-support/`: deterministic harnesses and fixtures used by tests.

## Related Specs

- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
- `SPEC-BUTLER-CLI` - Butler CLI
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
