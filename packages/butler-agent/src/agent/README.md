# agent

`packages/butler-agent/src/agent/` owns Butler's agent core. It contains turn execution, prompt
assembly, active context, cognition, work orchestration, agent-visible tools,
policy, output contracts, and public event contracts.

## Module Map

- `turn/`: model-tool continuation and native turn execution.
- `prompt/`: prompt assembly for persona, memory, context, and tools.
- `context/`: prompt budgeting, compaction, working memory, and tool-output
  artifacts.
- `cognition/`: memory, recall, feedback, know-how, profile-adjacent memory,
  and consolidation.
- `work/`: task, planned-task, todo, dashboard, and work orchestration state.
- `tools/`: agent-visible tool definitions and execution glue.
- `policy/`: runtime, routing, session-context, and tool-filtering policies.
- `output/`: localized messages, final-output contracts, tool progress, and
  session-title helpers.
- `events/`: public-safe turn event utilities.

## Boundaries

Agent code may call integrations through narrow clients, but it should not own
product interface implementations or external service pathing. Project-session
behavior belongs in policy plus tools; Project Ledger pathing belongs in
`packages/butler-agent/src/integrations/project-ledger/`.

## Related Specs

- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
- `SPEC-OPENAI-AUTH-AND-MODELS` - OpenAI Auth And Model Discovery
- `SPEC-MODEL-PROVIDER-CONTROL-UX` - Model And Provider Control UX
- `SPEC-AUTONOMOUS-PLANNED-DISPATCH` - Autonomous Planned Dispatch
- `SPEC-BUTLER-EXPERIENCE-POLISH` - Butler Experience Polish
