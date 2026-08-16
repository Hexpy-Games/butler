# cli

`packages/butler-agent/src/interfaces/cli/` owns the product command surface
behind the installed `butler` binary and its source entrypoint `bin/butler.js`.
The CLI is the supported local operator interface for installation, health checks,
configuration, auth/model control, gateway management, transport pairing, work
recovery, memory, search, automation, and diagnostics.

## Key Files

- `commands.json`: canonical command inventory shared by the Node entrypoint
  and TypeScript helpers.
- `command-registry.ts`: typed command lookup and priority helpers.
- `args.ts`: shared parsing for `--home`, `--data`, `--json`, `--yes`, and
  other common options.
- `output.ts`: privacy-safe JSON envelope helpers.
- `runtime.ts`: Butler-managed runtime resolver.
- `launcher.ts`: source for the native `butler` executable that release
  packaging prebuilds and source-checkout installs may build as a fallback.
- `core-command.ts`: Core command handlers.
- `operator-command.ts`: support and recovery handlers.
- `advanced-command.ts`: stable advanced command handlers.
- `private-env.ts`: CLI-only private environment helpers.

## Boundaries

CLI output must be safe by default. Do not print secrets, raw transcripts, raw
prompts, raw tool payloads, raw web queries, raw URLs, or private memory text.
Developer and release checks stay as package scripts unless a future spec
promotes them into product commands.

Local product URLs are allowed in gateway status output. `butler gateway status
app` and its JSON form must expose the app gateway server URL so operators can
confirm the Butler App port without reading private config files.

## Related Specs

- `SPEC-BUTLER-CLI` - Butler CLI
- `SPEC-CLI-CORE-COMMANDS` - Butler CLI Core Command Specs
- `SPEC-CLI-OPERATOR-COMMANDS` - Butler CLI Operator Command Specs
- `SPEC-CLI-ADVANCED-DEFERRED-COMMANDS` - Butler CLI Advanced And Deferred Command Specs
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
- `SPEC-AGENT-OWNED-GATEWAY-HOST` - Agent-Owned Gateway Host
