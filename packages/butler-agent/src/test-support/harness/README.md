# test harness

`packages/butler-agent/src/test-support/harness/` provides deterministic local session and transcript fixtures.
It lets tests exercise Butler conversations, worker results, recovery, and
transport behavior without relying on a live Telegram chat.

## Key Files

- `contracts.ts`: harness-facing session and transcript contracts.
- `session-store.ts`: durable local session state for tests and recovery.
- `durable-session-transcript.ts`: append-only transcript storage.
- `transcripts.ts`: transcript path and normalization helpers.
- `session-runtime.ts`: test runtime adapter for session turns.
- `telegram-session-transcript.ts`: Telegram-shaped transcript fixtures.
- `worker-transcript.ts`: worker transcript fixtures and summaries.

## Boundaries

Harness fixtures should model real product contracts rather than bypassing
them. Prefer gateway, session actor, transport adapter, and delivery guard paths
over isolated fake helpers.

## Related Specs

- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
