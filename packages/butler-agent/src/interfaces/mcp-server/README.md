# MCP server interface

`packages/butler-agent/src/interfaces/mcp-server/` owns Butler's local server-side support surface: config
loading, model controls, project discovery, dispatcher helpers, lifecycle
tools, watchdog checks, and local tool server wiring.

## Key Files

- `server.ts` and `index.ts`: local server entrypoints.
- `config.ts`, `constants.ts`, and `model.ts`: runtime config and model control
  helpers.
- `dispatcher.ts`, `lifecycle.ts`, `projects.ts`, and `skills.ts`: local
  product support tools.
- `watchdog.ts` and `checks/`: liveness, process, and service health checks.
- `watchdog-e2e-harness.ts`: watchdog-oriented test harness.

## Boundaries

The server may inspect local product state, but user-facing behavior should
still be exposed through the product CLI or conversation surfaces. Health output
must avoid secrets and raw private content.

To install dependencies:

```bash
${BUTLER_BUN:-bun} install
```

To run:

```bash
${BUTLER_BUN:-bun} run server.ts
```

Butler normally provides `BUTLER_BUN` through its managed runtime resolver.

## Related Specs

- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-MODEL-PROVIDER-CONTROL-UX` - Model And Provider Control UX
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-WORK-DASHBOARD` - Work Dashboard And Task Control Surface
