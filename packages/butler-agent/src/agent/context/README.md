# agent context

`packages/butler-agent/src/agent/context/` keeps active model context useful without storing private
raw content in diagnostics. It owns token-budget calculations, compaction,
prompt-cache policy, proactive session working memory, context metrics
retention, quality-retention checks, and large tool-output artifact handling.

## Key Files

- `budget.ts`: context pressure thresholds and token-budget helpers.
- `compaction.ts`: append-only compaction snapshots and auto-compaction flow.
- `working-memory.ts`: private active-session fact ledger injected before turns
  so users do not have to repeat recent facts after verbose exchanges.
- `conversation-context.ts`: bounded local transcript expansion for resolving
  references without replaying every raw turn in the default prompt.
- `prompt-cache-policy.ts`: provider-aware prompt-cache policy summaries.
- `quality-retention.ts`: deterministic checks that compacted context still
  answers as well as the full baseline fixtures.
- `tool-output-budgeter.ts`: converts large stdout/stderr into bounded model
  views plus recoverable artifacts.
- `metrics-retention.ts`: retention helpers for context metrics.

## Boundaries

Context telemetry must be raw-text-free. Full transcripts and artifacts belong
under Butler data; summaries and counters can be used for runtime decisions and
operator status.

## Related Specs

- `SPEC-CONTEXT-MANAGEMENT-OPTIMIZATION` - Context Management Optimization
- `SPEC-MODEL-PROVIDER-CONTROL-UX` - Model And Provider Control UX
- `SPEC-OPERATIONAL-METRICS-AND-CLI` - Operational Metrics And CLI
- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
