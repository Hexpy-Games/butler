use super::*;

#[tokio::test]
async fn store_preserves_transactions_outcomes_and_summary_authority() {
    let path = test_path("store");
    let (store, clock, _) = open_at(path.clone()).await;
    let busy_timeout = store
        .execute(|db| {
            db.query_row("PRAGMA busy_timeout", [], |row| row.get::<_, u64>(0))
                .map_err(ConversationError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(busy_timeout, 0);
    store.begin_turn(begin_input()).await.unwrap();
    let message = store
        .append_user_message(append_input("cm_request", "hello"))
        .await
        .unwrap();
    assert_eq!(
        store
            .execute(|db| {
                db.query_row(
                    "SELECT revision FROM conversation_public_source_state WHERE singleton=1",
                    [],
                    |row| row.get::<_, u64>(0),
                )
                .map_err(ConversationError::sqlite)
            })
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .get_session_by_gateway_binding("app", "runtime-1")
            .await
            .unwrap()
            .unwrap()
            .id,
        "cs_fixed"
    );
    assert_eq!(
        store
            .get_gateway_binding_for_conversation("cs_fixed", "app")
            .await
            .unwrap()
            .unwrap()
            .external_session_id,
        "runtime-1"
    );
    assert_eq!(
        store
            .read_message_by_source_ref("cs_fixed", " event-1 ")
            .await
            .unwrap()
            .unwrap(),
        message
    );
    assert_eq!(
        store
            .read_cognition_messages(ReadCognitionMessagesInput::default())
            .await
            .unwrap()
            .len(),
        1
    );
    let source_reader = ConversationSourceReader::open(&path).unwrap();
    assert_eq!(source_reader.count_source_bearing_messages().unwrap(), 1);
    assert_eq!(
        source_reader
            .read_message_by_source_ref_any_session("event-1")
            .unwrap()
            .unwrap(),
        message
    );
    source_reader.close().unwrap();
    assert_eq!(
        store
            .read_messages_around(ReadAroundInput {
                session_id: "cs_fixed".into(),
                anchor_message_id: Some("cm_request".into()),
                direction: Some("around".into()),
                limit: Some(10.0),
                include_compacted: false,
            })
            .await
            .unwrap()
            .len(),
        1
    );

    let mut bad = append_input("cm_rolled_back", "bad");
    bad.turn_id = Some("missing-turn".into());
    assert!(store.append_user_message(bad).await.is_err());
    assert!(
        store
            .read_message_by_id("cm_rolled_back")
            .await
            .unwrap()
            .is_none()
    );

    let base = TurnOutcomeCapsuleInput {
        id: Some("outcome-1".into()),
        session_id: "cs_fixed".into(),
        turn_id: "ct_fixed".into(),
        generation: 1.0,
        outcome: TurnOutcomeKind::Delivered,
        request_message_id: Some(message.message.id.clone()),
        public_assistant_message_id: None,
        provider_id: Some("openai".into()),
        model_ref: Some("openai/gpt".into()),
        evidence_refs: vec!["e1".into(), "e1".into()],
        unresolved_obligations: vec![],
        continuation: None,
        safe_code: None,
        created_at: Some("2026-09-14T00:00:01.000Z".into()),
    };
    store
        .finalize_turn(FinalizeTurnInput {
            turn_id: "ct_fixed".into(),
            status: Some("complete".into()),
            completed_at: Some("2026-09-14T00:00:01.000Z".into()),
            outcome_capsule: Some(base.clone()),
        })
        .await
        .unwrap();
    let first = store.read_turn_outcome("ct_fixed").await.unwrap().unwrap();
    assert_eq!(first.evidence_refs, vec!["e1"]);
    store
        .finalize_turn(FinalizeTurnInput {
            turn_id: "ct_fixed".into(),
            status: Some("complete".into()),
            completed_at: Some("2026-09-14T00:00:01.000Z".into()),
            outcome_capsule: Some(base.clone()),
        })
        .await
        .unwrap();
    assert_eq!(
        store.read_turn_outcome("ct_fixed").await.unwrap().unwrap(),
        first
    );
    let mut stale = base.clone();
    stale.generation = 0.0;
    store
        .finalize_turn(FinalizeTurnInput {
            turn_id: "ct_fixed".into(),
            status: Some("complete".into()),
            completed_at: Some("2026-09-14T00:00:01.000Z".into()),
            outcome_capsule: Some(stale),
        })
        .await
        .unwrap();
    assert_eq!(
        store.read_turn_outcome("ct_fixed").await.unwrap().unwrap(),
        first
    );
    let mut conflict = base;
    conflict.safe_code = Some("different".into());
    assert_eq!(
        store
            .finalize_turn(FinalizeTurnInput {
                turn_id: "ct_fixed".into(),
                status: Some("complete".into()),
                completed_at: Some("2026-09-14T00:00:01.000Z".into()),
                outcome_capsule: Some(conflict),
            })
            .await
            .unwrap_err()
            .code(),
        "conversation_outcome_generation_conflict"
    );
    assert_eq!(
        store.read_turn_outcome("ct_fixed").await.unwrap().unwrap(),
        first
    );
    let mut recovered = append_input("cm_recovered", "recovered");
    recovered.turn_id = None;
    recovered.source_ref = Some("recovered-1".into());
    recovered.provenance = Some(ConversationProvenance::Recovered);
    recovered.origin_ref = None;
    recovered.origin_reason = None;
    recovered.origin_version = None;
    store.append_user_message(recovered).await.unwrap();
    let candidate = store
        .read_origin_candidates_page(None, None)
        .await
        .unwrap()
        .into_iter()
        .find(|value| value.message_id == "cm_recovered")
        .unwrap();
    assert_eq!(
        store
            .record_origin_classification(RecordOriginClassificationInput {
                candidate,
                decision: ConversationOriginDecision {
                    kind: ConversationOriginKind::UserInput,
                    reference: Some("recovery:1".into()),
                    reason: "verified_public_ingress".into(),
                    version: "conversation-origin-v1".into(),
                    evidence: vec![],
                    complete: true,
                },
                correct_internal_origin: false,
            })
            .await
            .unwrap(),
        RecordOriginClassificationResult::Applied
    );
    store
        .sync_session_context("cs_fixed", Some("project-2".into()), "revision-2")
        .await
        .unwrap();
    assert_eq!(
        store
            .get_session("cs_fixed")
            .await
            .unwrap()
            .unwrap()
            .project_id
            .as_deref(),
        Some("project-2")
    );

    let hash = store
        .conversation_messages_source_hash(vec![message.message.id.clone()])
        .await
        .unwrap();
    store
        .write_summary(ConversationSummaryInput {
            session_id: "cs_fixed".into(),
            covers_from_seq: 1.0,
            covers_to_seq: 1.0,
            source_hash: hash,
            summary_text: "😀".into(),
            model: None,
            summary_id: Some("summary-1".into()),
            now: None,
        })
        .await
        .unwrap();
    let prompt = store
        .read_prompt_material("cs_fixed", Some(10.0))
        .await
        .unwrap();
    assert_eq!(prompt.summaries.len(), 1);
    assert_eq!(prompt.semantic_tail.len(), 1);
    store
        .execute(|db| {
            db.execute(
                "UPDATE conversation_parts SET content_json=?1 WHERE message_id='cm_request'",
                ["{\"text\":\"changed\"}"],
            )
            .map(|_| ())
            .map_err(ConversationError::sqlite)
        })
        .await
        .unwrap();
    assert!(store.read_summaries("cs_fixed").await.unwrap().is_empty());
    let restored = store
        .read_message_by_id("cm_request")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.message.status, ConversationStatus::Complete);
    assert_eq!(restored.message.compacted_by_summary_id, None);

    let existing_outbox_id = store
        .execute(|connection| {
            connection
                .query_row(
                    "SELECT outbox_id FROM conversation_projection_outbox \
                     ORDER BY outbox_rowid ASC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(ConversationError::sqlite)
        })
        .await
        .unwrap();
    *clock.forced_outbox.lock().unwrap() = Some(existing_outbox_id);
    assert!(
        store
            .append_user_message(append_input("cm_projection_rollback", "rollback"))
            .await
            .is_err()
    );
    assert!(
        store
            .read_message_by_id("cm_projection_rollback")
            .await
            .unwrap()
            .is_none()
    );
    store
        .execute(|db| {
            db.execute(
                "UPDATE conversation_parts SET content_json=?1 WHERE message_id='cm_recovered'",
                [r#""\ud800""#],
            )
            .map(|_| ())
            .map_err(ConversationError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .read_message_by_id("cm_recovered")
            .await
            .unwrap_err()
            .code(),
        "conversation_json_error"
    );
    store.close().await.unwrap();

    let raw = rusqlite::Connection::open(&path).unwrap();
    raw.execute(
        "ALTER TABLE conversation_sessions ADD COLUMN retained_extension TEXT",
        [],
    )
    .unwrap();
    raw.close().unwrap();
    let (reopened, _, _) = open_at(path.clone()).await;
    let retained = reopened
        .execute(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('conversation_sessions') WHERE name='retained_extension'",
                [],
                |row| row.get::<_, u64>(0),
            )
            .map_err(ConversationError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(retained, 1);
    reopened.close().await.unwrap();
    let _ignored_cleanup = std::fs::remove_file(path);
}
