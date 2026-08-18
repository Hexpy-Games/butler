import { createHash } from "node:crypto";

/**
 * Explicit stateful projection of the canonical Agent BTCC schema. The
 * importer compares this list with both the current schema and every legacy
 * source `btcc_*` table so newly introduced authority cannot be skipped.
 */
export const AGENT_BTCC_STATEFUL_TABLES = [
  "btcc_admission_claims",
  "btcc_authority_requests",
  "btcc_canonical_deliveries",
  "btcc_checkpoints",
  "btcc_context_documents",
  "btcc_continuation_triggers",
  "btcc_delivery_outbox",
  "btcc_guided_effect_recovery_hints",
  "btcc_guided_effect_recovery_payloads",
  "btcc_guided_effects",
  "btcc_guided_tool_calls",
  "btcc_guided_turn_work_bindings",
  "btcc_guided_work_checkpoint_revisions",
  "btcc_guided_work_closeout_diagnostics",
  "btcc_guided_work_disposition_commands",
  "btcc_guided_work_disposition_revisions",
  "btcc_guided_work_effect_blockers",
  "btcc_guided_work_legacy_imports",
  "btcc_guided_work_mutations",
  "btcc_guided_work_plan_revisions",
  "btcc_guided_work_relation_commands",
  "btcc_guided_work_results",
  "btcc_guided_work_review_revisions",
  "btcc_guided_work_session_heads",
  "btcc_guided_works",
  "btcc_inbound_inbox",
  "btcc_messages",
  "btcc_model_round_acceptances",
  "btcc_model_route_events",
  "btcc_progress_events",
  "btcc_r3_legacy_turn_cutovers",
  "btcc_r3_legacy_turn_quarantine",
  "btcc_records",
  "btcc_runtime_owners",
  "btcc_state_claims",
  "btcc_stop_requests",
  "btcc_terminal_settlement_wakes",
  "btcc_turns",
  "btcc_wake_authorizations",
  "btcc_wake_request_facts",
] as const;

export const AGENT_BTCC_MIGRATION_MANIFEST_ID = createHash("sha256")
  .update(JSON.stringify({ schema: "butler.agent-btcc-manifest.v1", tables: AGENT_BTCC_STATEFUL_TABLES }))
  .digest("hex");
