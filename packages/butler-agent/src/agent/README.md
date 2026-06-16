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

Native turn continuations are still part of the same user-facing turn. When a
direct WorkStream is extended across multiple tool-loop prompts, the
continuation prompt must preserve the current-turn persona reminder along with
the compact WorkStream state so long-running work does not drift into a neutral
reporting voice.

Worker and Steward non-trivial work share the same native tool-loop and
WorkStream discipline as Butler-facing sessions. Role differences are policy:
Workers cannot spawn child workers/orchestrations or publish principal-facing
reports, while Stewards remain internal project/workstream custodians. Neither
role may claim completion from task status alone; implementation work needs
durable execution evidence, validation evidence, or an explicit blocker.

## Related Specs

- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
- `SPEC-OPENAI-AUTH-AND-MODELS` - OpenAI Auth And Model Discovery
- `SPEC-MODEL-PROVIDER-CONTROL-UX` - Model And Provider Control UX
- `SPEC-AUTONOMOUS-PLANNED-DISPATCH` - Autonomous Planned Dispatch
- `SPEC-WORKER-BTCC-RUNTIME-NORMALIZATION` - Worker BTCC Runtime Normalization
- `SPEC-BUTLER-EXPERIENCE-POLISH` - Butler Experience Polish
