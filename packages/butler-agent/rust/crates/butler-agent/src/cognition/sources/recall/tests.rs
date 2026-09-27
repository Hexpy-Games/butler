use super::*;
use crate::cognition::sources::{
    ConversationSourceNotice, PreparedConversationSource, prepare_conversation_source,
    tests::{Fixture, begin, message, part},
};
use crate::conversation::{
    ConversationOriginKind, ConversationPartKind, ConversationProvenance, ConversationRole,
    ConversationSourceReader,
};
use serde_json::json;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn canonical_writer_original_source_hydrates_and_changed_scalar_fails() {
    let fixture = Fixture::new("recall-original");
    let store = fixture.open().await;
    store.begin_turn(begin()).await.unwrap();
    store
        .append_user_message(message(
            "cm_original",
            None,
            ConversationRole::User,
            ConversationOriginKind::UserInput,
            ConversationProvenance::Recovered,
            "2026-09-14T00:00:01.000Z",
            vec![part(
                ConversationPartKind::Text,
                json!({"text":"원문🙂 evidence"}),
            )],
        ))
        .await
        .unwrap();
    store.close().await.unwrap();
    let reader = ConversationSourceReader::open(&fixture.path).unwrap();
    let original = reader.read_message("cm_original").unwrap().unwrap();
    let source_hash = crate::cognition::sources::identity::recovered_parts_hash(&original).unwrap();
    let PreparedConversationSource::Plan(plan) = prepare_conversation_source(
        &reader,
        ConversationSourceNotice::Standalone {
            session_id: "cs_source",
            message_id: "cm_original",
            source_hash: &source_hash,
            extraction_version: "v-test",
        },
        "2026-09-14T00:00:02.000Z",
    )
    .unwrap() else {
        panic!("expected source plan");
    };
    let episode = crate::cognition::recall::RecallSourceEpisode {
        episode_id: plan.episode_id.clone(),
        revision: plan.revision.clone(),
        session_id: plan.session_id.clone(),
        turn_id: None,
    };
    let hydrated = hydrate_recall_sources(RecallSourceHydration {
        data_root: &fixture.root,
        memory_root: &fixture.root.join("cognition/memory"),
        reader: Some(&reader),
        rows: &plan.rows,
        episodes: std::slice::from_ref(&episode),
        max_graphemes: 480,
        deadline_at: i64::MAX,
        now_millis: || 0,
        compare_locale: str::cmp,
    });
    let row = &plan.rows[0];
    let RecallSourceResolution::Value(value) = hydrated.get(&row.source_id).unwrap() else {
        panic!("source must resolve");
    };
    assert_eq!(value.text(), "원문🙂 evidence");
    assert_eq!(value.excerpt, "원문🙂 evidence");
    assert_eq!(value.source_hash, row.content_hash);
    reader.close().unwrap();
    let raw = rusqlite::Connection::open(&fixture.path).unwrap();
    raw.execute(
        "UPDATE conversation_parts SET content_json=?1 WHERE message_id='cm_original'",
        [r#"{"text":"changed"}"#],
    )
    .unwrap();
    drop(raw);
    let reader = ConversationSourceReader::open(&fixture.path).unwrap();
    let changed = hydrate_recall_sources(RecallSourceHydration {
        data_root: &fixture.root,
        memory_root: &fixture.root.join("cognition/memory"),
        reader: Some(&reader),
        rows: &plan.rows,
        episodes: &[episode],
        max_graphemes: 480,
        deadline_at: i64::MAX,
        now_millis: || 0,
        compare_locale: str::cmp,
    });
    assert!(matches!(
        changed.get(&row.source_id),
        Some(RecallSourceResolution::Changed)
    ));
    reader.close().unwrap();
}

#[test]
fn explicit_rule_reads_durable_text_before_missing_conversation() {
    let fixture = Fixture::new("recall-typed");
    let memory_root = fixture.root.join("cognition/memory");
    let rules = memory_root.join("rules");
    std::fs::create_dir_all(&rules).unwrap();
    let text = "rule 원문🙂";
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    std::fs::write(rules.join("r1.md"), text).unwrap();
    std::fs::write(
        rules.join("r1.source.json"),
        json!({
            "schema":"butler.explicit-rule-binding.v1","state":"active","record_id":"r1",
            "revision":"rev1","operation_id":"op1","content_hash":hash,
            "project_id":null,"conversation_session_id":null,"conversation_message_id":null,
            "observed_at":"2026-09-14T00:00:00.000Z","operations":[]
        })
        .to_string(),
    )
    .unwrap();
    let row = crate::cognition::CognitionSourceRow {
        source_id: "source-r1".into(),
        episode_id: "e-r1".into(),
        revision: "rev1".into(),
        source_kind: "explicit_record".into(),
        conversation_session_id: None,
        conversation_message_id: None,
        part_id: "r1".into(),
        scalar_pointer: "/text".into(),
        byte_start: 0.0,
        byte_end: text.len() as f64,
        content_hash: hash,
        role: "explicit".into(),
        origin_kind: "unknown".into(),
        observed_at: "2026-09-14T00:00:00.000Z".into(),
        basis: "user_statement".into(),
    };
    let result = hydrate_recall_sources(RecallSourceHydration {
        data_root: &fixture.root,
        memory_root: &memory_root,
        reader: None,
        rows: std::slice::from_ref(&row),
        episodes: &[],
        max_graphemes: 480,
        deadline_at: i64::MAX,
        now_millis: || 0,
        compare_locale: str::cmp,
    });
    let RecallSourceResolution::Value(source) = result.get(&row.source_id).unwrap() else {
        panic!("typed source unavailable");
    };
    assert_eq!(source.text(), text);
    std::fs::write(rules.join("r1.md"), "changed").unwrap();
    let changed = hydrate_recall_sources(RecallSourceHydration {
        data_root: &fixture.root,
        memory_root: &memory_root,
        reader: None,
        rows: std::slice::from_ref(&row),
        episodes: &[],
        max_graphemes: 480,
        deadline_at: i64::MAX,
        now_millis: || 0,
        compare_locale: str::cmp,
    });
    assert!(matches!(
        changed.get(&row.source_id),
        Some(RecallSourceResolution::Changed)
    ));
}
