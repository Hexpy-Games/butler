# project-ledger integration

`packages/butler-agent/src/integrations/project-ledger/` owns Butler's adapter layer for the Project
Ledger CLI. The portable Ledger implementation remains under
`packages/project-ledger/`; agent-visible tools call this integration
instead of embedding CLI pathing directly in agent core.

## Key Files

- `client.ts`: resolves the repo-tracked Project Ledger CLI, selects the active
  project path, executes commands with JSON output, and returns safe envelopes
  to agent tools.

## Boundaries

This folder may know how to run Project Ledger, but it should not decide when
the agent must use it. Project-session policy belongs under `packages/butler-agent/src/agent/policy/`,
and agent tool exposure belongs under `packages/butler-agent/src/agent/tools/`.

## Related Specs

- `SPEC-PROJECT-LEDGER` - Project Ledger
- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
