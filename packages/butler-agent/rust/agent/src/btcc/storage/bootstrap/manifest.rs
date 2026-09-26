use sha2::{Digest, Sha256};

pub(super) const TABLES: [&str; 47] = [
    "btcc_admission_claims",
    "btcc_authority_requests",
    "btcc_canonical_deliveries",
    "btcc_checkpoints",
    "btcc_context_compactions",
    "btcc_context_documents",
    "btcc_continuation_triggers",
    "btcc_conversation_permissions",
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
    "btcc_session_relations",
    "btcc_state_claims",
    "btcc_steward_results",
    "btcc_stop_requests",
    "btcc_subsession_delegations",
    "btcc_subsession_directions",
    "btcc_subsession_outbox",
    "btcc_terminal_settlement_wakes",
    "btcc_turns",
    "btcc_wake_authorizations",
    "btcc_wake_request_facts",
];

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn manifest_id() -> String {
    #[derive(serde::Serialize)]
    struct Manifest<'a> {
        schema: &'static str,
        tables: &'a [&'static str],
    }
    let encoded = serde_json::to_vec(&Manifest {
        schema: "butler.agent-btcc-manifest.v1",
        tables: &TABLES,
    })
    .expect("static manifest serialization");
    digest(&encoded)
}
