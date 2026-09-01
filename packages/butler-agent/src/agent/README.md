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
- `tools/`: native tool groups. Immediate subdirectories are group names, and
  each second-level directory is an exact snake_case provider-visible tool name
  with its own definition and executor entrypoint.
- `tools/ shared support files: `: shared helpers for native tool execution and bounded
  provider result projection that are not provider-visible tools.
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

Worker and Steward non-trivial work share the same native BTCC tool loop.
Each Worker owns one session-scoped Micro Work and receives the Steward's
compact implementation brief plus admitted project context. Role differences
are policy: Workers cannot delegate, mutate the parent Work or Project Ledger,
or publish principal-facing reports. Completion follows the actual Micro Work
result and proportional checks, not a separate proof campaign.

## Related Specs

- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
- `SPEC-OPENAI-AUTH-AND-MODELS` - OpenAI Auth And Model Discovery
- `SPEC-MODEL-PROVIDER-CONTROL-UX` - Model And Provider Control UX
- `SPEC-AUTONOMOUS-PLANNED-DISPATCH` - Autonomous Planned Dispatch
- `SPEC-WORKER-MICRO-WORK-BTCC` - Worker Micro Work BTCC
- `SPEC-BUTLER-EXPERIENCE-POLISH` - Butler Experience Polish
- `SPEC-TOOL-RUNTIME-PROGRESSIVE-SURFACE` - Progressive Tool Surface
- `SPEC-TOOL-RUNTIME-EVIDENCE-CAPABILITY-LEDGER` - Evidence Capability Ledger
- `SPEC-TOOL-RUNTIME-RECOVERABLE-DELIVERY-STATE` - Recoverable Delivery State
