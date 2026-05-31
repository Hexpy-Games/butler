# mcp-server checks

`packages/butler-agent/src/interfaces/mcp-server/checks/` contains watchdog check implementations. Each check
should produce bounded, actionable health information without exposing secrets
or raw private state.

## Key Files

- `butler-main-api.ts`: native main API and notification guard checks.
- Native service restart checks live under the service supervisor and watchdog
  paths.

## Boundaries

Checks should be side-effect-light by default. Repair or restart behavior must
remain explicit in the caller and should be covered by operational reliability
tests.

## Related Specs

- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
