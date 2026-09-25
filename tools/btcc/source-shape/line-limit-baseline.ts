/**
 * Ratchet for successor files that already exceeded MAX_PHYSICAL_LINES when the
 * limit started being enforced. Each file may shrink but never grow past its
 * recorded physical line count; lower (or delete) an entry after splitting a
 * file. Files not listed here must stay within MAX_PHYSICAL_LINES.
 */
export const LINE_LIMIT_BASELINE: Readonly<Record<string, number>> = {
  "packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-store.ts": 355,
  "packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts": 367,
  "packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-guided-transition-writer.ts": 351,
  "packages/butler-agent/src/agent/adapters/btcc/sqlite/steward-observer-store.ts": 385,
  "packages/butler-agent/src/agent/adapters/btcc/sqlite/subsession-store.ts": 378,
  "packages/butler-agent/src/agent/adapters/btcc/sqlite/turn-admission-repository.ts": 414,
  "packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts": 492,
  "packages/butler-agent/src/agent/btcc/agent-loop/guided-phase-policy.ts": 379,
  "packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-execution-boundary.ts": 383,
  "packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-agent.ts": 598,
  "packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-prompt.ts": 358,
  "packages/butler-agent/src/agent/btcc/authority/contracts.ts": 375,
  "packages/butler-agent/src/agent/btcc/contracts.ts": 371,
  "packages/butler-agent/src/agent/btcc/projection/projection.ts": 363,
  "packages/butler-agent/src/agent/btcc/subsessions/contracts.ts": 446,
  "packages/butler-agent/src/agent/btcc/subsessions/service.ts": 423,
  "packages/butler-agent/src/agent/btcc/turn/prepare-turn.ts": 409,
  "packages/butler-agent/src/agent/btcc/turn/runtime.ts": 359,
  "packages/butler-agent/src/agent/conversation/projection-reader-store.ts": 475,
  "packages/butler-agent/src/agent/conversation/session-admission.ts": 411,
  "packages/butler-agent/src/agent/conversation/store/message-records.ts": 498,
  "packages/butler-agent/src/agent/conversation/types.ts": 353,
};
