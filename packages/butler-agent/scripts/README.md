# Butler Agent Scripts

`packages/butler-agent/scripts/` contains operational entrypoints used behind
the product CLI, installer, services, and validation scripts.

## Key Areas

- Installer and setup: `setup.ts`, `upgrade-report.ts`, `doctor.sh`.
- Lifecycle: `start-butler.sh`, `stop-butler.sh`, `restart-butler.sh`,
  `service-control.sh`, `service-daemon.sh`, `native-service.ts`,
  `native-service-daemon.ts`, `os-service-adapter.ts`, and
  `os-service-registration.ts`.
- Runtime turns: `native-butler-main.ts`, `native-steward-turn.ts`,
  `run-text-prompt.ts`, and `run-tool-prompt.ts`.
- Maintenance and status: `status-context.ts`, `metrics-status.ts`,
  `prune-context-maintenance.ts`, and diagnostic scripts.
- Auth and transport helpers: `openai-oauth-login.ts`, `send-telegram.sh`, and
  chat-id resolution utilities.
- `lib/`: shared shell helpers.

## Boundaries

Do not make users memorize these paths for normal operation. If a script is
needed by users, expose it through the CLI first and document the CLI command.

## Related Specs

- `SPEC-BUTLER-CLI` - Butler CLI
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-OPENAI-AUTH-AND-MODELS` - OpenAI Auth And Model Discovery
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-OS-SERVICE-ADAPTER` - OS Service Adapter And Foreground Supervisor
