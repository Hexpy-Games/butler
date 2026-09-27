//! Generic record effects: the publication occurrence journal, the SQLite
//! lock shard that admits them, and the replay/conflict/reconcile answers.

use serde_json::json;

use butler_ledger::project_ledger::{
    LedgerCommand, LedgerEffectRequest, ProjectLedgerRecordUpdate,
};

use super::golden::assert_golden;
use super::harness::Harness;

fn updates(value: serde_json::Value) -> Vec<ProjectLedgerRecordUpdate> {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn record_effects_keep_their_journal_lock_shard_and_answers() {
    let mut h = Harness::new("effects");
    h.init().await;
    let root = h.root.clone();
    let request = |key: &str, updates: Vec<ProjectLedgerRecordUpdate>| LedgerEffectRequest {
        project_root: root.clone(),
        effect_key: key.into(),
        updates,
    };
    let first = updates(json!([
        {"operation": "create", "id": "DEC-7", "kind": "decision", "title": "Use SQLite",
         "status": "accepted", "body": "Decision body", "reason": "Embedded", "priority": 2},
        {"operation": "create", "id": "W-7", "kind": "work", "title": "Adopt SQLite",
         "status": "proposed", "spec": "SPEC-7", "acceptance": "Queries run",
         "requiresCommitEvidence": true},
        {"operation": "create", "id": "T-7", "kind": "task", "parentId": "W-7",
         "title": "Write schema", "status": "todo", "validation": "unit"},
    ]));
    let second = updates(json!([
        {"id": "DEC-7", "status": "superseded", "implementation": "W-7",
         "codeCommits": "[]", "ledgerCommits": "none", "specExemption": true, "mitigation": "n/a"},
        {"operation": "update", "id": "W-7", "kind": "work", "status": "scoped",
         "review": "ok", "report": "r", "validation": "v"},
    ]));
    let invalid = updates(json!([{"id": "NOPE", "title": "Missing"}]));
    let steps = [
        ("apply first", request("effect-1", first.clone())),
        ("apply first again", request("effect-1", first.clone())),
        (
            "apply first conflicting",
            request("effect-1", second.clone()),
        ),
        ("apply second", request("effect-2", second.clone())),
        ("apply invalid", request("effect-3", invalid.clone())),
    ];
    for (step, request) in steps {
        let result = h.ledger.apply_record_effect(request).await;
        h.record_debug(step, &result);
    }
    for (step, request) in [
        ("reconcile first", request("effect-1", first.clone())),
        ("reconcile invalid", request("effect-3", invalid)),
        ("reconcile unknown", request("effect-9", second)),
    ] {
        let result = h.ledger.reconcile_record_effect(request).await;
        h.record_debug(step, &result);
    }
    h.command("check", LedgerCommand::Check, json!({})).await;
    h.ledger.close().await;
    assert_golden("effects.txt", &h.finish());
}
