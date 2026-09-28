//! Format pin of `query_memory` results over a seeded conversation.
//!
//! The golden in `fixtures/exact-query.json` was generated from the
//! pre-typing `serde_json::Value` query. Run with `BUTLER_BLESS_FORMAT=1` to
//! regenerate it only when a format change is intended.

use super::*;
use crate::cognition::ExactMemoryQuery;
use butler_turn::conversation::CanonicalMemoryReadBinding;

#[tokio::test]
async fn exact_query_results_cursors_and_failures_keep_their_bytes() {
    let fixture = Fixture::new("exact-query-pin");
    fixture
        .seed_pair(
            "Straße remembers the Deploy key",
            "Public answer about deploy",
        )
        .await;
    let query = ExactMemoryQuery::new(&fixture.root, 2);
    let binding = CanonicalMemoryReadBinding {
        runtime_session_id: "external".into(),
        turn_id: "turn".into(),
        project_id: Some("project".into()),
    };
    let first_page = query
        .query(
            binding.clone(),
            json!({"terms":["deploy"],"match_mode":"any","case_sensitive":false,"limit":1}),
        )
        .await
        .unwrap();
    let cursor = first_page["next_cursor"].clone();
    let mut outputs = vec![first_page];
    for args in [
        json!({"terms":["deploy"],"match_mode":"any","case_sensitive":false,"limit":1,"cursor":cursor}),
        json!({"query":"Straße"}),
        json!({"query":"straße","case_sensitive":false,"speaker":"user","order":"latest"}),
        json!({"terms":["Deploy","key"],"match_mode":"all","scope":"current_session","session_ids":["session"]}),
        json!({"query":"answer","event_kind":"outbound","project_filter":"selected","project_ids":["project"],"include_internal":true}),
        json!({"query":"answer","time":{"basis":"conversation","from":"2026-09-13T00:00:00Z","to":"2026-09-15T00:00:00+00:00"}}),
        json!({"limit":0}),
        json!({"query":"x","terms":["y"]}),
        json!({"match_mode":"any"}),
        json!({"speaker":"user","event_kind":"outbound"}),
        json!({"time":{"basis":"event","from":"a","to":"b"}}),
        json!({"terms":[1]}),
        json!({"cursor":"not-base64!"}),
        json!("not an object"),
    ] {
        outputs.push(query.query(binding.clone(), args).await.unwrap());
    }
    query.close().await.unwrap();
    let text = butler_core::json::pretty(&json!(outputs));
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/registration/tests/fixtures/exact-query.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "exact query format changed");
}
