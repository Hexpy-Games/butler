use super::{cursor, evidence};
use crate::cognition::recall::{
    RecallAdmittedChannels, RecallProjectFilter, RecallRequest, RecallRuntime, RecallScope,
};

fn request() -> RecallRequest {
    RecallRequest {
        cue: "find source".into(),
        seed_phrases: vec![],
        vector_queries: vec![],
        include_vector: false,
        include_internal: false,
        limit: 2,
        scope: RecallScope::CurrentSession,
        project_filter: RecallProjectFilter::Any,
        project_ids: vec![],
        session_ids: vec![],
        as_of: "2026-09-19T00:00:00.000Z".into(),
        as_of_explicit: true,
        time: None,
        cursor: None,
        admitted_channels: Some(RecallAdmittedChannels::default()),
        runtime: RecallRuntime {
            session_id: "session".into(),
            turn_id: "turn".into(),
            current_user_message: "message".into(),
            native_operation_id: "operation".into(),
            project_id: None,
        },
    }
}

#[test]
fn cursor_keeps_metadata_only_and_ttl_is_from_creation() {
    let store = cursor::CursorStore::default();
    let input = request();
    let page = store
        .insert(
            &input,
            "generation",
            "revision",
            vec![cursor::Candidate {
                episode_ref: "episode".into(),
                revision: "r1".into(),
                channels: vec!["lexical".into()],
                matched_node_ref: None,
                association_path: vec![],
                qualifications: vec![],
            }],
            1_000,
        )
        .unwrap();
    let wire = cursor::encode(&page.key, 0);
    let read = store.read(&wire, 300_999).unwrap();
    assert_eq!(read.inventory.candidates[0].episode_ref, "episode");
    assert_eq!(read.offset, 0);
    let decimal_wire = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        format!(
            r#"{{"schema":"butler.recall-cursor.v2","key":"{}","offset":1.0}}"#,
            page.key
        ),
    );
    assert_eq!(store.read(&decimal_wire, 300_999).unwrap().offset, 1);
    assert_eq!(
        store.read(&wire, 301_001).unwrap_err().code,
        "cursor_expired"
    );
    assert_eq!(
        store.read("invalid", 301_001).unwrap_err().code,
        "invalid_arguments"
    );
}

#[test]
fn cursor_hash_excludes_turn_and_operation_but_binds_runtime_session() {
    let original = request();
    let expected = cursor::argument_hash(&original, &original.as_of).unwrap();
    let mut updated = original.clone();
    updated.runtime.turn_id = "another".into();
    updated.runtime.native_operation_id = "another".into();
    assert_eq!(
        cursor::argument_hash(&updated, &updated.as_of).unwrap(),
        expected
    );
    updated.runtime.session_id = "another".into();
    assert_ne!(
        cursor::argument_hash(&updated, &updated.as_of).unwrap(),
        expected
    );
}

#[test]
fn raw_excerpt_and_v2_handles_match_unchanged_bun_source() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/evidence-source-bun.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let phrases = case["phrases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            evidence::raw_excerpt(text, &phrases, 480),
            case["excerpt"].as_str().unwrap()
        );
    }
    for case in fixture["handles"].as_array().unwrap() {
        let generation = case["generation"].as_str().unwrap();
        let source = case["source"].as_str().unwrap();
        let handle = evidence::handle(generation, source);
        assert_eq!(handle, case["handle"].as_str().unwrap());
        assert_eq!(evidence::raw_source_id(&handle).as_deref(), Some(source));
    }
}

#[tokio::test]
async fn caller_drop_does_not_abandon_admitted_recall_and_close_drains_it() {
    let reader = std::sync::Arc::new(super::NativeMemoryRecall::new(
        std::env::temp_dir().join(format!("butler-recall-drain-{}", uuid::Uuid::new_v4())),
        crate::cognition::CognitionPathEnvironment::default(),
        std::sync::Arc::new(crate::js_date::parse_iso_millis),
        std::sync::Arc::new(|a, b| a.cmp(b)),
        std::sync::Arc::new(|| 1_789_776_000_000),
        0,
    ));
    let active = {
        let reader = reader.clone();
        tokio::spawn(async move { reader.recall(request()).await })
    };
    tokio::task::yield_now().await;
    active.abort();
    tokio::time::timeout(std::time::Duration::from_secs(2), reader.close())
        .await
        .expect("close must release an accepted operation waiting for admission");
    assert_eq!(
        reader.recall(request()).await.unwrap_err().code,
        "memory_recall_closed"
    );
}
