//! Byte-level pin of the identity decision history a new source revision
//! rewrites: the invalidation appended to the new job and the old job's
//! decisions left as stored.
//!
//! The golden in `fixtures/identity-history.json` was generated from the
//! pre-typing `serde_json::Value` invalidation (merge-base e1d5f72b1). Run
//! with `BUTLER_BLESS_FORMAT=1` to regenerate it only when a format change is
//! intended.

use super::*;
use rusqlite::params;

/// An apply as the decision writer stored it: every field in its order, a
/// review note, and one key no writer here knows. Its previous head points
/// at a decision that no longer exists, so the invalidation cannot restore
/// the earlier redirect.
fn apply_record(source: &str) -> serde_json::Value {
    json!({
        "schema":"butler.memory-identity-decision.v1",
        "decision_ref":"a".repeat(64),
        "operation_id":"op-apply",
        "payload_digest":"b".repeat(64),
        "operation":"apply",
        "decision_origin":"operator_cli",
        "literal_loser":"loser",
        "reason":"explicit_alias",
        "review_note":"same person",
        "literal_canonical":"canonical",
        "resolved_target":"canonical",
        "previous_head":{"job_ref":"c".repeat(64),"decision_ref":"d".repeat(64)},
        "previous_direct_redirect":"earlier",
        "previous_owner":"loser",
        "resulting_direct_redirect":"canonical",
        "resulting_owner":"canonical",
        "source_refs":[source],
        "node_type":"entity",
        "identity_scope":"user",
        "project_id":null,
        "decision_source":{"source_ref":source,"episode_id":"episode","revision":"r",
            "content_hash":"h","byte_start":0,"byte_end":4,"quote":"Loser",
            "quote_byte_start":0,"quote_byte_end":5,"project_id":null,
            "session_id":"session","origin_kind":"user_input","role":"user",
            "observed_at":"2026-09-14T00:00:01.000Z"},
        "loser_source":null,
        "canonical_source":null,
        "target_decision":null,
        "source_revision":"r",
        "source_observed_at":"2026-09-14T00:00:01.000Z",
        "recorded_at":"2026-09-14T00:00:03.000Z",
        "recorded_outcome":"applied",
        "custom_note":"kept"
    })
}

/// The first revision's job holds the apply and the loser's head points at
/// it; the first source is the one the next revision supersedes.
fn seed_decision(fixture: &Fixture, job: &str, episode: &str) {
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let source: String = graph
        .query_row(
            "SELECT source_id FROM memory_chunk_sources ORDER BY source_id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    graph.execute(
        "INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES('canonical','entity','Canonical','user',?1)",
        params![NOW],
    ).unwrap();
    graph.execute(
        "INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at,canonical_node_id,identity_history_job_id,identity_history_ref) VALUES('loser','entity','Loser','user',?1,'canonical',?2,?3)",
        params![NOW, job, "a".repeat(64)],
    ).unwrap();
    graph
        .execute(
            "UPDATE memory_projection_jobs SET identity_decisions_json=?1 WHERE job_id=?2",
            params![json!([apply_record(&source)]).to_string(), job],
        )
        .unwrap();
    graph
        .execute(
            "INSERT INTO memory_chunk_graph_refs VALUES(?1,'identity_source_job',?2,?3)",
            params![episode, source, format!("identity_job:{job}")],
        )
        .unwrap();
}

#[tokio::test]
async fn invalidated_identity_decision_keeps_its_bytes() {
    let fixture = Fixture::new("identity-history-pin");
    fixture.seed().await;
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts::new())).unwrap());
    let service = service(coordinator);
    let ConversationRegistrationOutcome::Registered(first) = service
        .register_conversation_source(fixture.input("first"))
        .await
        .unwrap()
    else {
        panic!("first revision must register")
    };
    seed_decision(&fixture, &first.job_id, &first.episode_id);
    fixture.advance_turn().await;
    let ConversationRegistrationOutcome::Registered(second) = service
        .register_conversation_source(fixture.input_generation("second", 2.0))
        .await
        .unwrap()
    else {
        panic!("new revision must register")
    };
    service.close().await;
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let history = |job: &str| -> String {
        graph
            .query_row(
                "SELECT identity_decisions_json FROM memory_projection_jobs WHERE job_id=?1",
                [job],
                |row| row.get(0),
            )
            .unwrap()
    };
    let node: (Option<String>, String, String) = graph
        .query_row(
            "SELECT canonical_node_id,identity_history_job_id,identity_history_ref FROM memory_nodes WHERE id='loser'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let pinned = json!({
        "old_job": history(&first.job_id),
        "new_job": history(&second.job_id),
        "node": [node.0, node.1 == second.job_id, node.2],
    });
    let text = butler_core::json::pretty(&pinned);
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/registration/tests/fixtures/identity-history.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "identity decision history format changed");
}
